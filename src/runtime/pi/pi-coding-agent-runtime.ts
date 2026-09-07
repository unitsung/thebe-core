import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  CreateRuntimeSessionOptions,
  CustomToolDefinition,
  NormalizedEvent,
  PromptInput,
  RuntimeAuth,
  RuntimeModel,
  RuntimeModelRef,
  RuntimeProvider,
  RuntimeSession,
  ThinkingLevel,
} from "../types.ts";
import {
  PI_BUILTIN_TOOLS,
  PI_RUNTIME_ID,
  asPromptInput,
} from "../types.ts";
import { createExplicitResourceLoader } from "./explicit-loader.ts";
import { loadPiSdk, type PiSdk } from "./load-pi.ts";
import { mapPiEvent, mapPiMessages } from "./map-events.ts";
import { exportPiSession } from "./pi-export.ts";

type PiSession = {
  sessionId: string;
  prompt: (
    text: string,
    options?: {
      images?: unknown[];
      streamingBehavior?: "steer" | "followUp";
    },
  ) => Promise<void>;
  steer: (text: string) => Promise<void>;
  followUp: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
  compact: () => Promise<unknown>;
  dispose: () => void;
  messages: unknown[];
  setModel: (model: unknown) => Promise<void>;
  setThinkingLevel: (level: string) => void;
  navigateTree: (targetId: string) => Promise<unknown>;
  getUserMessagesForForking: () => Array<{ entryId: string; text: string }>;
  isStreaming?: boolean;
  sessionManager: {
    getLeafId: () => string | null;
    createBranchedSession: (leaf: string) => string | undefined;
    getEntries: () => Array<{ type: string; id?: string; message?: unknown }>;
    appendMessage?: (message: unknown) => void;
  };
  state?: unknown;
};

export type PiCodingAgentRuntimeOptions = {
  cwd?: string;
  agentDir?: string;
  sessionDir?: string;
  inMemory?: boolean;
  modelRuntime?: InstanceType<PiSdk["ModelRuntime"]>;
  model?: unknown;
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
    const listeners = new Set<(event: NormalizedEvent) => void>();
    const permissionHandler = create.permissionHandler
      ? {
          async request(request: Parameters<NonNullable<CreateRuntimeSessionOptions["permissionHandler"]>["request"]>[0]) {
            for (const listener of listeners) {
              listener({
                type: "permission_requested",
                permissionId: request.permissionId,
                toolName: request.toolName,
                toolCallId: request.toolCallId,
              });
            }
            return create.permissionHandler!.request(request);
          },
        }
      : undefined;
    const extensionRuntime = sdk.createExtensionRuntime();
    let permissionExtension: unknown[] = [];
    if (permissionHandler) {
      try {
        permissionExtension = [
          await sdk.loadExtensionFromFactory(
            (pi: {
              on: (
                event: string,
                handler: (
                  payload: {
                    toolName: string;
                    toolCallId?: string;
                    input?: unknown;
                  },
                ) => Promise<unknown>,
              ) => void;
            }) => {
              const required = new Set(create.toolsRequiringApproval ?? []);
              pi.on("tool_call", async (event) => {
                if (!required.has(event.toolName)) {
                  return undefined;
                }
                const permissionId = randomUUID();
                const decision = await permissionHandler.request({
                  permissionId,
                  toolName: event.toolName,
                  toolCallId: event.toolCallId ?? permissionId,
                  args: event.input,
                });
                if (decision !== "allow") {
                  return { block: true, reason: "denied by user" };
                }
                return undefined;
              });
            },
            create.cwd ?? cwd,
            sdk.createEventBus(),
            extensionRuntime,
            "thebe://permission-gate",
          ),
        ];
      } catch {
        permissionExtension = [];
      }
    }
    const resourceLoader = createExplicitResourceLoader({
      systemPrompt: create.systemPrompt ?? "You are Thebe.",
      enabledResources: create.enabledResources,
      sdk,
      extensions: permissionExtension,
      extensionRuntime,
    });
    const settingsManager = sdk.SettingsManager.inMemory({
      retry: { enabled: false, maxRetries: 0 },
    });
    const { session } = await sdk.createAgentSession({
      cwd: create.cwd ?? cwd,
      agentDir: options.agentDir,
      modelRuntime,
      model: options.model as never,
      thinkingLevel: "off",
      tools,
      customTools: create.customTools.map((tool) => toPiTool(sdk, tool)),
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    live.set(session.sessionId, session as PiSession);
    return wrapSession(session as PiSession, create, listeners);
  }

  function wrapSession(
    session: PiSession,
    create: CreateRuntimeSessionOptions,
    existingListeners?: Set<(event: NormalizedEvent) => void>,
  ): RuntimeSession {
    const listeners =
      existingListeners ?? new Set<(event: NormalizedEvent) => void>();
    let revertedLeaf: string | undefined;
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
    function emit(event: NormalizedEvent): void {
      for (const listener of listeners) {
        listener(event);
      }
    }

    async function promptInput(input: string | PromptInput): Promise<void> {
      const prompt = asPromptInput(input);
      const images = (prompt.files ?? [])
        .filter((file) => file.mediaType.startsWith("image/"))
        .map((file) => ({
          type: "image",
          source: {
            type: "base64",
            mediaType: file.mediaType,
            data: file.data,
          },
        }));
      const otherFiles = (prompt.files ?? []).filter(
        (file) => !file.mediaType.startsWith("image/"),
      );
      const extra = otherFiles
        .map(
          (file) =>
            `[file: ${file.filename ?? "attachment"} (${file.mediaType})]`,
        )
        .join("\n");
      const text = extra ? `${prompt.text}\n${extra}` : prompt.text;
      await session.prompt(text, images.length > 0 ? { images } : undefined);
    }

    return {
      runtimeSessionId: session.sessionId,
      prompt: promptInput,
      steer: (text) => session.steer(text),
      followUp: (text) => session.followUp(text),
      abort: async () => {
        emit({ type: "interrupted" });
        await session.abort();
      },
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
      async setModel(model: RuntimeModelRef): Promise<void> {
        const resolved = modelRuntime.getModel(model.providerID, model.modelID);
        if (!resolved) {
          throw new Error(
            `unknown model: ${model.providerID}/${model.modelID}`,
          );
        }
        await session.setModel(resolved);
      },
      async setThinkingLevel(level: ThinkingLevel): Promise<void> {
        session.setThinkingLevel(level);
      },
      async revert(): Promise<void> {
        const users = session.getUserMessagesForForking?.() ?? [];
        const target = users.at(-1);
        if (!target) {
          throw new Error("nothing to revert");
        }
        revertedLeaf = session.sessionManager.getLeafId() ?? undefined;
        await session.navigateTree(target.entryId);
      },
      async unrevert(): Promise<void> {
        if (!revertedLeaf) {
          throw new Error("nothing to unrevert");
        }
        await session.navigateTree(revertedLeaf);
        revertedLeaf = undefined;
      },
      dispose: () => {
        session.dispose();
        listeners.clear();
      },
    };
  }

  type PendingOAuthLogin = {
    providerId: string;
    url?: string;
    instructions?: string;
    deviceCode?: {
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    };
    urlReady: Promise<void>;
    resolveUrlReady: () => void;
    rejectUrlReady: (error: unknown) => void;
    resolvePrompt: (input: string) => void;
    completion: Promise<{ kind: "oauth"; providerId: string }>;
  };

  const pendingOAuth = new Map<string, PendingOAuthLogin>();

  function ensureOAuthLogin(
    providerId: string,
    openUrl?: (url: string) => Promise<void> | void,
  ): PendingOAuthLogin {
    const existing = pendingOAuth.get(providerId);
    if (existing) {
      if (openUrl && existing.url) {
        void openUrl(existing.url);
      }
      return existing;
    }
    let resolveUrlReady!: () => void;
    let rejectUrlReady!: (error: unknown) => void;
    const urlReady = new Promise<void>((resolve, reject) => {
      resolveUrlReady = resolve;
      rejectUrlReady = reject;
    });
    let urlSettled = false;
    const settleUrl = () => {
      if (!urlSettled) {
        urlSettled = true;
        resolveUrlReady();
      }
    };
    let resolvePrompt!: (input: string) => void;
    const promptInput = new Promise<string>((resolve) => {
      resolvePrompt = resolve;
    });
    // The local-callback-server path can settle login without prompt input;
    // never let the orphaned prompt promise surface as unhandled.
    promptInput.catch(() => {});
    const entry: PendingOAuthLogin = {
      providerId,
      urlReady,
      resolveUrlReady,
      rejectUrlReady,
      resolvePrompt,
      completion: Promise.resolve({ kind: "oauth" as const, providerId }),
    };
    pendingOAuth.set(providerId, entry);
    entry.completion = (async () => {
      try {
        await modelRuntime.login(providerId, "oauth", {
          prompt: async () => promptInput,
          notify: (event: {
            type: string;
            url?: string;
            instructions?: string;
            userCode?: string;
            verificationUri?: string;
            intervalSeconds?: number;
            expiresInSeconds?: number;
          }) => {
            if (event.type === "auth_url" && event.url) {
              entry.url = event.url;
              entry.instructions = event.instructions;
              settleUrl();
              void openUrl?.(event.url);
            } else if (
              event.type === "device_code" &&
              event.userCode &&
              event.verificationUri
            ) {
              entry.deviceCode = {
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                intervalSeconds: event.intervalSeconds,
                expiresInSeconds: event.expiresInSeconds,
              };
              settleUrl();
            }
          },
        });
        return { kind: "oauth" as const, providerId };
      } catch (error) {
        if (!urlSettled) {
          urlSettled = true;
          rejectUrlReady(error);
        }
        throw error;
      } finally {
        if (pendingOAuth.get(providerId) === entry) {
          pendingOAuth.delete(providerId);
        }
      }
    })();
    // authorizeOAuth intentionally does not await this; keep the rejection
    // observed here so background logins never trigger unhandled rejections.
    entry.completion.catch(() => {});
    return entry;
  }

  const auth: RuntimeAuth = {
    async setApiKey(providerId, apiKey) {
      await modelRuntime.setRuntimeApiKey(providerId, apiKey);
    },
    async loginOAuth(providerId, interaction) {
      const entry = ensureOAuthLogin(providerId, interaction?.openUrl);
      return entry.completion;
    },
    async authorizeOAuth(providerId) {
      try {
        if (await modelRuntime.checkAuth(providerId)) {
          return { providerId, connected: true as const };
        }
      } catch {
        // fall through and start the login so the real error surfaces
      }
      const entry = ensureOAuthLogin(providerId);
      // Resolves on first auth URL / device code; also resolves when login
      // settles without emitting either (then re-check below decides).
      await Promise.race([
        entry.urlReady,
        entry.completion.then(
          () => undefined,
          () => undefined,
        ),
      ]);
      try {
        if (await modelRuntime.checkAuth(providerId)) {
          return { providerId, connected: true as const };
        }
      } catch {
        // fall through to the pending response
      }
      // If login already failed, surface it instead of a hollow pending.
      let failed: unknown;
      let settled = false;
      entry.completion.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          failed = error;
          settled = true;
        },
      );
      await Promise.resolve();
      if (settled && failed !== undefined) {
        throw failed;
      }
      return {
        providerId,
        pending: true as const,
        url: entry.url,
        instructions: entry.instructions,
        deviceCode: entry.deviceCode,
      };
    },
    async submitOAuthCallback(providerId, input) {
      const entry = pendingOAuth.get(providerId);
      if (!entry) {
        throw new Error(`unknown OAuth authorization: ${providerId}`);
      }
      if (!input.trim()) {
        throw new Error("OAuth callback input required");
      }
      entry.resolvePrompt(input);
    },
    async logout(providerId) {
      await modelRuntime.logout(providerId);
    },
    async check(providerId) {
      const status = await modelRuntime.checkAuth(providerId);
      return { ok: Boolean(status) };
    },
    async listProviders(): Promise<RuntimeProvider[]> {
      const providers = modelRuntime.getProviders() as Array<{
        id: string;
        name?: string;
      }>;
      const out: RuntimeProvider[] = [];
      for (const provider of providers) {
        const status = await modelRuntime.checkAuth(provider.id);
        out.push({
          id: provider.id,
          name: provider.name,
          connected: Boolean(status),
        });
      }
      return out;
    },
  };

  function toRuntimeModel(model: {
    id: string;
    provider: string;
    name?: string;
  }): RuntimeModel {
    return {
      providerID: model.provider,
      modelID: model.id,
      name: model.name,
    };
  }

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
    async listModels(query?: { all?: boolean }) {
      if (query?.all === false) {
        const available = await modelRuntime.getAvailable();
        return (available as Array<{ id: string; provider: string; name?: string }>).map(
          toRuntimeModel,
        );
      }
      const models = modelRuntime.getModels() as Array<{
        id: string;
        provider: string;
        name?: string;
      }>;
      return models.map(toRuntimeModel);
    },
    async listAvailableModels() {
      const available = await modelRuntime.getAvailable();
      return (available as Array<{ id: string; provider: string; name?: string }>).map(
        toRuntimeModel,
      );
    },
    async listProviders() {
      return auth.listProviders();
    },
    async forkSession(runtimeSessionId, create, fork) {
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
        const leaf = fork?.atEntryId ?? opened.getLeafId();
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
      const leaf = fork?.atEntryId ?? parent.sessionManager.getLeafId();
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
