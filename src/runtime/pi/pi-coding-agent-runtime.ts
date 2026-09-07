import { mkdirSync } from "node:fs";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import type {
  AgentRuntime,
  CreateRuntimeSessionOptions,
  CustomToolDefinition,
  NormalizedEvent,
  RuntimeAuth,
  RuntimeSession,
} from "../types.ts";
import { PI_BUILTIN_TOOLS, PI_RUNTIME_ID } from "../types.ts";
import { createExplicitResourceLoader } from "./explicit-loader.ts";
import { loadPiSdk, type PiSdk } from "./load-pi.ts";
import { mapPiEvent, mapPiMessages } from "./map-events.ts";
import { exportPiSession } from "./pi-export.ts";

type PiSession = {
  sessionId: string;
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
  compact: () => Promise<unknown>;
  dispose: () => void;
  messages: unknown[];
  sessionManager: {
    getLeafId: () => string | null;
    createBranchedSession: (leaf: string) => string | undefined;
    getEntries: () => Array<{ type: string; message?: unknown }>;
  };
  state?: unknown;
};

export type PiCodingAgentRuntimeOptions = {
  cwd?: string;
  agentDir?: string;
  sessionDir?: string;
  inMemory?: boolean;
  modelRuntime?: InstanceType<PiSdk["ModelRuntime"]>;
  model?: Model<string>;
  apiKey?: { providerId: string; key: string };
};

export async function createPiCodingAgentRuntime(
  options: PiCodingAgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const sdk = await loadPiSdk();
  const cwd = options.cwd ?? process.cwd();
  const inMemory = options.inMemory ?? !options.sessionDir;
  if (options.sessionDir) {
    mkdirSync(options.sessionDir, { recursive: true });
  }
  if (options.agentDir) {
    mkdirSync(options.agentDir, { recursive: true });
  }

  const modelRuntime =
    options.modelRuntime ??
    (await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      authPath: options.agentDir
        ? `${options.agentDir}/auth.json`
        : undefined,
      modelsPath: options.agentDir
        ? `${options.agentDir}/models.json`
        : undefined,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }));

  if (options.apiKey) {
    await modelRuntime.setRuntimeApiKey(
      options.apiKey.providerId,
      options.apiKey.key,
    );
  }

  const live = new Map<string, PiSession>();

  async function openPiSession(
    create: CreateRuntimeSessionOptions,
    sessionManager: InstanceType<PiSdk["SessionManager"]>,
  ): Promise<RuntimeSession> {
    const tools = [
      ...(create.builtinTools ?? PI_BUILTIN_TOOLS),
      ...create.customTools.map((tool) => tool.name),
    ];
    const resourceLoader = createExplicitResourceLoader({
      systemPrompt: create.systemPrompt ?? "You are Thebe.",
      enabledResources: create.enabledResources,
      sdk,
    });
    const settingsManager = sdk.SettingsManager.inMemory({
      retry: { enabled: false, maxRetries: 0 },
    });
    const { session } = await sdk.createAgentSession({
      cwd: create.cwd ?? cwd,
      agentDir: options.agentDir,
      modelRuntime,
      model: options.model,
      thinkingLevel: "off",
      tools,
      customTools: create.customTools.map((tool) => toPiTool(sdk, tool)),
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    live.set(session.sessionId, session as PiSession);
    return wrapSession(session as PiSession, create);
  }

  function wrapSession(
    session: PiSession,
    create: CreateRuntimeSessionOptions,
  ): RuntimeSession {
    const listeners = new Set<(event: NormalizedEvent) => void>();
    session.subscribe((event) => {
      const mapped = mapPiEvent(event as Parameters<typeof mapPiEvent>[0]);
      if (!mapped) {
        return;
      }
      if (mapped.type === "session_end") {
        mapped.text = lastAssistantText(session);
      }
      for (const listener of listeners) {
        listener(mapped);
      }
    });
    return {
      runtimeSessionId: session.sessionId,
      prompt: (text) => session.prompt(text),
      abort: () => session.abort(),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      lastAssistantText: () => lastAssistantText(session),
      toolNames: () => [
        ...(create.builtinTools ?? PI_BUILTIN_TOOLS),
        ...create.customTools.map((tool) => tool.name),
      ],
      compact: async () => {
        try {
          await session.compact();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!message.includes("Nothing to compact")) {
            throw error;
          }
        }
      },
      exportSession: () => exportPiSession(session as never),
      messages: () => mapPiMessages(session.messages),
      dispose: () => {
        session.dispose();
        listeners.clear();
      },
    };
  }

  const auth: RuntimeAuth = {
    async setApiKey(providerId, apiKey) {
      await modelRuntime.setRuntimeApiKey(providerId, apiKey);
    },
    async loginOAuth(providerId) {
      await modelRuntime.login(providerId, "oauth", {
        prompt: async () => "",
        notify: () => {},
      });
      return { kind: "oauth", providerId };
    },
    async logout(providerId) {
      await modelRuntime.logout(providerId);
    },
    async check(providerId) {
      const status = await modelRuntime.checkAuth(providerId);
      return { ok: Boolean(status) };
    },
  };

  return {
    runtimeId: PI_RUNTIME_ID,
    async createSession(create) {
      const sessionManager = inMemory
        ? sdk.SessionManager.inMemory(create.cwd ?? cwd)
        : sdk.SessionManager.create(create.cwd ?? cwd, options.sessionDir);
      return openPiSession(create, sessionManager);
    },
    async resumeSession(runtimeSessionId, create) {
      const existing = live.get(runtimeSessionId);
      if (existing && inMemory) {
        return wrapSession(existing, create);
      }
      const listed = inMemory
        ? []
        : await sdk.SessionManager.list(create.cwd ?? cwd, options.sessionDir);
      const info = listed.find(
        (row: { id: string; path: string }) => row.id === runtimeSessionId,
      );
      if (!info) {
        throw new Error(`unknown runtime session: ${runtimeSessionId}`);
      }
      return openPiSession(
        create,
        sdk.SessionManager.open(info.path, options.sessionDir),
      );
    },
    async listSessions() {
      if (inMemory) {
        return [...live.keys()].map((runtimeSessionId) => ({
          runtimeSessionId,
        }));
      }
      const listed = await sdk.SessionManager.list(cwd, options.sessionDir);
      return listed.map((row: { id: string }) => ({
        runtimeSessionId: row.id,
      }));
    },
    async forkSession(runtimeSessionId, create) {
      const parent = live.get(runtimeSessionId);
      if (!parent) {
        const listed = inMemory
          ? []
          : await sdk.SessionManager.list(create.cwd ?? cwd, options.sessionDir);
        const info = listed.find(
          (row: { id: string; path: string }) => row.id === runtimeSessionId,
        );
        if (!info) {
          throw new Error(`unknown runtime session: ${runtimeSessionId}`);
        }
        const opened = sdk.SessionManager.open(info.path, options.sessionDir);
        const leaf = opened.getLeafId();
        if (!leaf) {
          throw new Error("cannot fork empty session");
        }
        const path = opened.createBranchedSession(leaf);
        if (!path) {
          throw new Error("Pi fork did not persist a child session");
        }
        return openPiSession(
          create,
          sdk.SessionManager.open(path, options.sessionDir),
        );
      }
      const leaf = parent.sessionManager.getLeafId();
      if (!leaf) {
        throw new Error("cannot fork empty session");
      }
      const path = parent.sessionManager.createBranchedSession(leaf);
      if (path) {
        return openPiSession(
          create,
          sdk.SessionManager.open(path, options.sessionDir),
        );
      }
      const child = sdk.SessionManager.inMemory(create.cwd ?? cwd, {
        parentSession: runtimeSessionId,
      });
      for (const entry of parent.sessionManager.getEntries()) {
        if (entry.type === "message") {
          child.appendMessage(entry.message);
        }
      }
      return openPiSession(create, child);
    },
    auth() {
      return auth;
    },
  };
}

function toPiTool(sdk: PiSdk, tool: CustomToolDefinition) {
  return sdk.defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as never,
    executionMode: "sequential",
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ) => {
      const result = await tool.execute(toolCallId, params, signal);
      return {
        content: result.content,
        details: result.details ?? {},
        isError: result.isError,
      };
    },
  });
}

function lastAssistantText(session: PiSession): string {
  const mapped = mapPiMessages(session.messages);
  for (let i = mapped.length - 1; i >= 0; i--) {
    const message = mapped[i];
    if (message?.role === "assistant") {
      return message.text;
    }
  }
  return "";
}
