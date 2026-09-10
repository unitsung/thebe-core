import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  BackgroundTask,
  ThebeSessionContext,
  ForkSessionOptions,
} from "../types.ts";
import {
  PI_BUILTIN_TOOLS,
  PI_RUNTIME_ID,
  asPromptInput,
  isInlineTextFile,
} from "../types.ts";
import { createExplicitResourceLoader } from "./explicit-loader.ts";
import { loadPiSdk, type PiSdk } from "./load-pi.ts";
import { mapPiEvent, mapPiMessages } from "./map-events.ts";
import { exportPiSession } from "./pi-export.ts";
import { permissionRisk, summarizeArgs } from "../../tools/redaction.ts";

export function sanitizeBashEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const sanitized: Record<string, string | undefined> = {};
  const sensitivePatterns = [
    /^THEBE_/i,
    /^DATABASE_/i,
    /_(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)$/i,
  ];
  for (const [key, val] of Object.entries(env)) {
    if (key.startsWith("PI_")) {
      sanitized[key] = val;
      continue;
    }
    const isSensitive = sensitivePatterns.some((pattern) => pattern.test(key));
    if (!isSensitive) {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

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
    const modelsPath = `${options.agentDir}/models.json`;
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown>;
    } catch {}
    const providers = (data.providers ?? {}) as Record<string, Record<string, unknown>>;
    try {
      const configPath = join(
        process.env.THEBE_CONFIG_DIR ?? join(process.env.HOME ?? ".", ".thebe"),
        "config.json",
      );
      const userConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
        providers?: Record<string, { baseUrl?: string }>;
      };
      if (userConfig.providers) {
        for (const [pId, pCfg] of Object.entries(userConfig.providers)) {
          if (pCfg?.baseUrl) {
            providers[pId] = { ...(providers[pId] ?? {}), baseUrl: pCfg.baseUrl };
          }
        }
      }
    } catch {}
    if (process.env.OPENAI_BASE_URL) {
      providers["openai"] = {
        ...(providers["openai"] ?? {}),
        baseUrl: process.env.OPENAI_BASE_URL,
      };
    }
    if (process.env.ANTHROPIC_BASE_URL) {
      providers["anthropic"] = {
        ...(providers["anthropic"] ?? {}),
        baseUrl: process.env.ANTHROPIC_BASE_URL,
      };
    }
    data.providers = providers;
    try {
      writeFileSync(modelsPath, JSON.stringify(data, null, 2), "utf8");
    } catch {}
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

  function resolveModelRef(
    providerId: string,
    modelId: string,
  ): PiModelShape | undefined {
    let actualModelId = modelId;
    if (providerId === "opencode") {
      if (modelId === "muse-spark-1.3-free" || modelId === "muse-spark-1.3") {
        actualModelId = "muse-spark-1.3-contributor-free";
      } else if (
        modelId === "muse-spark-1.2-free" ||
        modelId === "muse-spark-1.2"
      ) {
        actualModelId = "muse-spark-1.2-contributor-free";
      }
    }
    let found = modelRuntime.getModel(providerId, actualModelId);
    if (!found && actualModelId.endsWith("-free")) {
      found = modelRuntime.getModel(
        providerId,
        actualModelId.replace(/-free$/, "-contributor-free"),
      );
    }
    if (!found) {
      found = modelRuntime.getModel(providerId, modelId);
    }
    return found as PiModelShape | undefined;
  }

  const live = new Map<string, PiSession>();
  let quiesced = false;
  const livenessRegistry = new Map<string, () => boolean>();

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
                argsSummary: request.argsSummary,
                risk: request.risk,
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
                  argsSummary: summarizeArgs(event.input),
                  risk: permissionRisk(event.toolName),
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
      defaultProjectTrust: "always",
      retry: { enabled: false, maxRetries: 0 },
    });
    settingsManager.setDefaultProjectTrust?.("always");
    const sanitizedBash = sdk.createBashTool(create.cwd ?? cwd, {
      spawnHook: (ctx: { command: string; cwd: string; env: Record<string, string | undefined> }) => ({
        ...ctx,
        env: sanitizeBashEnv(ctx.env),
      }),
    });
    const piCustomTools = [
      ...create.customTools.map((tool) => toPiTool(sdk, tool)),
      ...(tools.includes("bash") ? [sanitizedBash] : []),
    ];

    const requestedModel =
      create.model ??
      (typeof options.model === "object" &&
      options.model &&
      "providerId" in options.model
        ? (options.model as RuntimeModelRef)
        : undefined);
    let resolvedModel = requestedModel
      ? resolveModelRef(requestedModel.providerId, requestedModel.modelId)
      : undefined;
    if (requestedModel && !resolvedModel) {
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
      resolvedModel = resolveModelRef(
        requestedModel.providerId,
        requestedModel.modelId,
      );
    }
    resolvedModel ??= options.model
      ? options.model
      : resolveModelRef("opencode", "muse-spark-1.3-free");

    const { session } = await sdk.createAgentSession({
      cwd: create.cwd ?? cwd,
      agentDir: options.agentDir,
      modelRuntime,
      model: resolvedModel as never,
      thinkingLevel: "off",
      tools,
      customTools: piCustomTools,
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
        .filter(
          (file) =>
            (!file.mode || file.mode === "inline") &&
            file.data &&
            file.mediaType.startsWith("image/"),
        )
        .map((file) => ({
          type: "image",
          source: {
            type: "base64",
            mediaType: file.mediaType,
            data: file.data!,
          },
        }));
      const inlined = (prompt.files ?? [])
        .filter(
          (file) =>
            (!file.mode || file.mode === "inline") &&
            file.data &&
            isInlineTextFile(file.mediaType),
        )
        .map((file) => {
          const name = file.filename ?? "attachment";
          let text: string;
          try {
            text = Buffer.from(file.data!, "base64").toString("utf8");
          } catch {
            text = "";
          }
          return `[file: ${name} (${file.mediaType})]\n${text}`;
        })
        .join("\n\n");
      const references = (prompt.files ?? [])
        .filter((file) => file.mode === "reference")
        .map(
          (file) =>
            `[file reference: ${file.path ?? file.filename ?? "attachment"} (${file.mediaType})]`,
        )
        .join("\n");
      const lines = (prompt.files ?? [])
        .filter((file) => file.mode === "lines")
        .map(
          (file) =>
            `[file snippet: ${file.path ?? file.filename ?? "attachment"} lines ${file.lineRange?.start ?? 1}-${file.lineRange?.end ?? 1} (${file.mediaType})]`,
        )
        .join("\n");
      const otherFiles = (prompt.files ?? [])
        .filter(
          (file) =>
            (!file.mode || file.mode === "inline") &&
            !file.mediaType.startsWith("image/") &&
            !isInlineTextFile(file.mediaType),
        )
        .map(
          (file) =>
            `[file: ${file.filename ?? "attachment"} (${file.mediaType})]`,
        )
        .join("\n");
      const text = [prompt.text, inlined, references, lines, otherFiles]
        .filter((part) => part.length > 0)
        .join("\n");
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
      async stopToolCall(toolCallId: string): Promise<void> {
        emit({
          type: "tool_end",
          toolName: "interrupted",
          toolCallId,
          isError: true,
          text: "tool call stopped by user",
        });
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
      async getContextUsage(): Promise<ThebeSessionContext> {
        const raw = (session as { getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined }).getContextUsage?.();
        const fallbackWindow =
          (session as { model?: { contextWindow?: number } }).model?.contextWindow ?? 1_048_576;
        const maxTokens = raw?.contextWindow ?? fallbackWindow;
        let usedTokens = raw?.tokens ?? 0;
        if (usedTokens === null || usedTokens === 0) {
          const msgs = mapPiMessages(session.messages);
          const chars = msgs.reduce((acc, m) => acc + (m.text?.length ?? 0), 0);
          usedTokens = Math.ceil(chars / 4);
        }
        return {
          contextUsage: { usedTokens, maxTokens },
          estimatedCost: { amount: 0, currency: "USD" },
          compaction: {
            lastCompactedAt: undefined,
            nearThreshold: usedTokens > maxTokens * 0.8,
          },
        };
      },
      async listBackgroundTasks(): Promise<BackgroundTask[]> {
        return [];
      },
      async stopBackgroundTask(_taskId: string): Promise<void> {
        // no-op
      },
      async setModel(model: RuntimeModelRef): Promise<void> {
        let resolved = resolveModelRef(model.providerId, model.modelId);
        if (!resolved) {
          await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
          resolved = resolveModelRef(model.providerId, model.modelId);
        }
        if (!resolved) {
          throw new Error(
            `unknown model: ${model.providerId}/${model.modelId}`,
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
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
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
      await entry.completion;
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
        auth?: { apiKey?: unknown; oauth?: unknown };
      }>;
      const out: RuntimeProvider[] = [];
      for (const provider of providers) {
        const methods: Array<"apiKey" | "oauth"> = [];
        if (provider.auth?.apiKey) {
          methods.push("apiKey");
        }
        if (provider.auth?.oauth) {
          methods.push("oauth");
        }
        let authStatus: RuntimeProvider["authStatus"];
        try {
          const status = await modelRuntime.checkAuth(provider.id);
          authStatus = status ? "connected" : "missing";
        } catch {
          authStatus = "error";
        }
        out.push({
          id: provider.id,
          displayName: provider.name,
          authMethods: methods,
          authStatus,
        });
      }
      return out;
    },
    async testProvider(providerId: string): Promise<{ ok: boolean; message?: string }> {
      try {
        const ok = await modelRuntime.checkAuth(providerId);
        return {
          ok: Boolean(ok),
          message: ok
            ? "Provider authenticated successfully"
            : "Provider authentication check failed",
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  type PiModelShape = {
    id: string;
    provider: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    thinkingLevelMap?: unknown;
  };

  function toRuntimeModel(
    model: PiModelShape,
    availableIds?: Set<string>,
  ): RuntimeModel {
    return {
      providerId: model.provider,
      modelId: model.id,
      displayName: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      supportsThinking:
        model.reasoning === true || model.thinkingLevelMap != null || undefined,
      available: availableIds ? availableIds.has(model.id) : undefined,
    };
  }

  function modelKey(model: PiModelShape): string {
    return `${model.provider}/${model.id}`;
  }

  async function availableKeys(providerId?: string): Promise<Set<string>> {
    try {
      const available = (await modelRuntime.getAvailable(
        providerId,
      )) as PiModelShape[];
      return new Set(available.map(modelKey));
    } catch {
      return new Set();
    }
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
      if (existing) {
        return wrapSession(existing, create);
      }
      let info: { id: string; path: string } | undefined;
      if (!inMemory) {
        const listed = (await sdk.SessionManager.list(
          create.cwd ?? cwd,
          options.sessionDir,
        )) as Array<{ id: string; path: string }>;
        info = listed.find((row) => row.id === runtimeSessionId);
        if (!info) {
          const all = (await sdk.SessionManager.listAll(
            options.sessionDir,
          )) as Array<{ id: string; path: string }>;
          info = all.find((row) => row.id === runtimeSessionId);
        }
      }
      if (info) {
        return openPiSession(
          create,
          sdk.SessionManager.open(info.path, options.sessionDir),
        );
      }
      const sessionManager = inMemory
        ? sdk.SessionManager.inMemory(create.cwd ?? cwd, { id: runtimeSessionId })
        : sdk.SessionManager.create(create.cwd ?? cwd, options.sessionDir, {
            id: runtimeSessionId,
          });
      return openPiSession(create, sessionManager);
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
    async listModels(query?: { all?: boolean; providerId?: string }) {
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
      const models = (
        query?.providerId
          ? modelRuntime.getModels(query.providerId)
          : modelRuntime.getModels()
      ) as PiModelShape[];
      const keys = await availableKeys(query?.providerId);
      const filtered =
        query?.all === false
          ? models.filter((model) => keys.has(modelKey(model)))
          : models;
      const list = filtered.map((model) => toRuntimeModel(model, keys));
      if (!query?.providerId || query.providerId === "opencode") {
        const contributor = list.find(
          (m) =>
            m.providerId === "opencode" &&
            m.modelId === "muse-spark-1.3-contributor-free",
        );
        const hasFree = list.some(
          (m) =>
            m.providerId === "opencode" && m.modelId === "muse-spark-1.3-free",
        );
        if (contributor && !hasFree) {
          list.unshift({
            ...contributor,
            modelId: "muse-spark-1.3-free",
            displayName: "Muse Spark 1.3 Free",
          });
        }
      }
      return list;
    },
    async listAvailableModels(query?: { providerId?: string }) {
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
      const available = (await modelRuntime.getAvailable(
        query?.providerId,
      )) as PiModelShape[];
      const keys = new Set(available.map(modelKey));
      const list = available.map((model) => toRuntimeModel(model, keys));
      if (!query?.providerId || query.providerId === "opencode") {
        const contributor = list.find(
          (m) =>
            m.providerId === "opencode" &&
            m.modelId === "muse-spark-1.3-contributor-free",
        );
        const hasFree = list.some(
          (m) =>
            m.providerId === "opencode" && m.modelId === "muse-spark-1.3-free",
        );
        if (contributor && !hasFree) {
          list.unshift({
            ...contributor,
            modelId: "muse-spark-1.3-free",
            displayName: "Muse Spark 1.3 Free",
          });
        }
      }
      return list;
    },
    async listProviders() {
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
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
    async quiesce(): Promise<void> {
      quiesced = true;
    },
    async unquiesce(): Promise<void> {
      quiesced = false;
    },
    isQuiesced(): boolean {
      return quiesced;
    },
    registerSessionLiveness(sessionId: string, isActive: () => boolean): () => void {
      livenessRegistry.set(sessionId, isActive);
      return () => {
        livenessRegistry.delete(sessionId);
      };
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
