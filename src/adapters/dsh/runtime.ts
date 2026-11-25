import { randomUUID } from "node:crypto";
import { appendFileSync, rmSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import type {
  AgentRuntime,
  BackgroundTask,
  CreateRuntimeSessionOptions,
  NormalizedEvent,
  PromptInput,
  RuntimeExport,
  RuntimeMessage,
  RuntimeModel,
  RuntimeModelRef,
  RuntimeProvider,
  RuntimeAuth,
  RuntimeSession,
  ThebeSessionContext,
  ThinkingLevel,
} from "../../agent/runtime/interface.ts";
import {
  DSH_RUNTIME_ID as RUNTIME_ID,
  PI_BUILTIN_TOOLS,
  asPromptInput,
} from "../../agent/runtime/interface.ts";
import { sanitizeBashEnv } from "../../agent/security/process-env.ts";
import { mapDshSessionEvent, type DshSessionEventLike } from "./events.ts";

export const DSH_RUNTIME_ID = RUNTIME_ID;

type DshRunResultLike = {
  sessionId?: string;
  events: DshSessionEventLike[];
};

type DshSessionLike = {
  run(
    input: string | unknown[],
    options?: {
      onNotification?: (notification: HarnessNotification) => void;
    }
  ): Promise<DshRunResultLike>;
};

export type DshHarnessLike = {
  client: {
    onRequest(
      handler: (
        method: string,
        params: Record<string, unknown>
      ) => Promise<unknown>
    ): void;
    prompt(sessionId: string, blocks: unknown[]): Promise<string>;
  };
  start(): Promise<void>;
  session(sessionId: string): DshSessionLike;
  resumeSession(sessionId: string): Promise<DshSessionLike>;
  close(): Promise<void>;
};

export type DshHarnessFactory = (input: {
  sessionId: string;
  home: string;
  cwd: string;
  provider: string;
  model: string;
  apiKey?: string;
  env: NodeJS.ProcessEnv;
  patches?: string[];
}) => DshHarnessLike | Promise<DshHarnessLike>;

export type DeepSeekHarnessRuntimeOptions = {
  cwd: string;
  sessionRoot: string;
  provider?: string;
  model?: string;
  models?: readonly string[];
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  coreMcp?: {
    token: string;
    registerSession?: (
      sessionId: string,
      binding: {
        customTools: CreateRuntimeSessionOptions["customTools"];
        permissionHandler?: CreateRuntimeSessionOptions["permissionHandler"];
        toolsRequiringApproval?: readonly string[];
        emit: (event: NormalizedEvent) => void;
      }
    ) => { url: string };
  };
  /** A container is the process boundary, so do not nest DSH's host sandbox. */
  disableDshSandbox?: boolean;
  harnessFactory?: DshHarnessFactory;
};

export type DeepSeekHarnessRuntime = AgentRuntime & {
  /** Point future DSH launches at this Core's MCP surface. */
  mountCoreMcp(input: {
    token: string;
    registerSession?: NonNullable<
      DeepSeekHarnessRuntimeOptions["coreMcp"]
    >["registerSession"];
    unregisterSession?: (sessionId: string) => void;
  }): void;
};

const DEFAULT_PROVIDER = "deepseek-official";
const DEFAULT_MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const;
const DEFAULT_CONTEXT_WINDOW = 1_048_576;

function disabledToolRows(
  builtinTools: readonly string[] | undefined
): string[] {
  const builtin = new Set(builtinTools ?? PI_BUILTIN_TOOLS);
  const fs = ["read", "write", "edit"].some((tool) => builtin.has(tool));
  const search = ["ls", "find", "grep"].some((tool) => builtin.has(tool));
  const selected = new Map([
    ["tool-bash", builtin.has("bash")],
    ["tool-pwsh", builtin.has("bash")],
    ["tool-fs", fs],
    ["tool-fs-search", search],
    ["tool-plugin-manager", false],
    ["tool-web", false],
    ["tool-jobs", false],
    ["tool-skill", false],
    ["tool-agent-team", false],
    ["tool-subagent", false],
    ["tool-subagent-control", false],
    ["tool-subagent-fork", false],
    ["tool-workflow", false],
    ["tool-goal", false],
    ["tool-todo", false],
    ["tool-office", false],
    ["present", false],
    ["tool-schedule", false],
    ["tool-ask-user", false],
  ]);
  const rows: string[] = [];
  for (const [id, enabled] of selected) {
    if (!enabled) rows.push(`- id: ${id}`, "  disabled: true");
  }
  return rows;
}

function modelDisplayName(modelId: string): string {
  if (modelId === "deepseek-flash") return "DeepSeek V4.1 Flash";
  if (modelId === "deepseek-v4-flash") return "DeepSeek V4 Flash";
  if (modelId === "deepseek-v4-pro") return "DeepSeek V4 Pro";
  return modelId;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function unsupported(operation: string): Error {
  return new Error(
    `DeepSeek Harness runtime does not support ${operation} through the SDK protocol.`
  );
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sessionId(): string {
  return `session-${randomUUID().replaceAll("-", "")}`;
}

function decodePromptFile(data: string | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64").toString("utf8");
  } catch {
    return "";
  }
}

async function promptBlocks(input: PromptInput): Promise<unknown[]> {
  const blocks: Array<Record<string, string>> = [];
  if (input.text) blocks.push({ type: "text", text: input.text });
  for (const file of input.files ?? []) {
    if (
      file.data &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        file.mediaType
      )
    ) {
      blocks.push({
        type: "image",
        data: file.data,
        mimeType: file.mediaType,
      });
      continue;
    }
    if (
      file.data &&
      (file.mediaType.startsWith("text/") ||
        file.mediaType === "application/json")
    ) {
      const body = decodePromptFile(file.data);
      blocks.push({
        type: "text",
        text: `Attached file ${file.filename ?? "file"} (${file.mediaType}):\n${body}`,
      });
      continue;
    }
    if (file.path) {
      blocks.push({
        type: "text",
        text: `Attached file reference: ${file.path}`,
      });
    }
  }
  return blocks;
}

class DshRuntimeSession implements RuntimeSession {
  readonly runtimeSessionId: string;
  readonly #provider: string;
  readonly #createOptions: CreateRuntimeSessionOptions;
  readonly #transcriptPath: string;
  readonly #createHarness: (
    model: RuntimeModelRef,
    create: CreateRuntimeSessionOptions,
    emit: (event: NormalizedEvent) => void
  ) => Promise<DshHarnessLike>;
  readonly #disposeSession?: () => void;
  readonly #listeners = new Set<(event: NormalizedEvent) => void>();
  readonly #messages: RuntimeMessage[] = [];
  readonly #events: DshSessionEventLike[] = [];
  readonly #seenEvents = new Set<string>();
  readonly #toolNames = new Map<string, string>();
  #harness: DshHarnessLike | undefined;
  #resumePending: boolean;
  #active = false;
  #abortRequested = false;
  #closed = false;
  #lastAssistant = "";
  #totalTokens = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #cacheReadTokens = 0;
  #cacheWriteTokens = 0;
  #model: RuntimeModelRef;
  #generation = 0;

  constructor(input: {
    runtimeSessionId: string;
    transcriptPath: string;
    provider: string;
    resume: boolean;
    create: CreateRuntimeSessionOptions;
    getModel: () => RuntimeModelRef;
    createHarness: (
      model: RuntimeModelRef,
      create: CreateRuntimeSessionOptions,
      emit: (event: NormalizedEvent) => void
    ) => Promise<DshHarnessLike>;
    disposeSession?: () => void;
  }) {
    this.runtimeSessionId = input.runtimeSessionId;
    this.#transcriptPath = input.transcriptPath;
    this.#provider = input.provider;
    this.#createOptions = input.create;
    this.#createHarness = input.createHarness;
    this.#disposeSession = input.disposeSession;
    this.#resumePending = input.resume;
    this.#model = input.create.model ?? input.getModel();
    if (this.#model.providerId !== this.#provider) {
      throw new Error(
        `DeepSeek Harness runtime is configured for ${this.#provider}, not ${this.#model.providerId}.`
      );
    }
  }

  #emit(event: NormalizedEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A UI subscriber cannot disrupt the runtime or its other listeners.
      }
    }
  }

  #persist(kind: "event" | "message", value: unknown): void {
    try {
      appendFileSync(
        this.#transcriptPath,
        `${JSON.stringify({ kind, value })}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
    } catch {
      // DSH remains authoritative for execution; local read models retry on later writes.
    }
  }

  async loadTranscript(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#transcriptPath, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const row = record(JSON.parse(line));
        if (row.kind === "message") {
          const message = record(row.value);
          if (
            typeof message.id === "string" &&
            ["user", "assistant", "tool"].includes(String(message.role)) &&
            typeof message.text === "string"
          ) {
            this.#messages.push(message as RuntimeMessage);
            if (message.role === "assistant") {
              this.#lastAssistant = message.text;
            }
            if (message.role === "tool") {
              if (
                typeof message.toolCallId === "string" &&
                typeof message.toolName === "string"
              ) {
                this.#toolNames.set(message.toolCallId, message.toolName);
              }
            }
          }
        } else if (row.kind === "event") {
          const event = record(row.value);
          if (typeof event.type === "string") {
            this.#events.push(event as DshSessionEventLike);
          }
        }
      } catch {
        // A partial final JSONL row is ignored; the next append starts a new row.
      }
    }
  }

  #consume(value: DshSessionEventLike): void {
    const key =
      value.seq !== undefined
        ? `seq:${value.seq}`
        : `event:${value.type}:${JSON.stringify(value.data ?? {})}`;
    if (this.#seenEvents.has(key)) return;
    this.#seenEvents.add(key);
    this.#events.push(value);
    this.#persist("event", value);

    if (value.type === "tool/call") {
      const data = record(value.data);
      if (typeof data.callId === "string" && typeof data.name === "string") {
        this.#toolNames.set(data.callId, data.name);
      }
    }
    if (value.type === "assistant/message") {
      const usage = record(record(value.data).usage);
      if (typeof usage.totalTokens === "number") {
        this.#totalTokens += usage.totalTokens;
      }
      if (typeof usage.inputTokens === "number") {
        this.#inputTokens += usage.inputTokens;
      }
      if (typeof usage.outputTokens === "number") {
        this.#outputTokens += usage.outputTokens;
      }
      if (typeof usage.cacheReadTokens === "number") {
        this.#cacheReadTokens += usage.cacheReadTokens;
      }
      if (typeof usage.cacheWriteTokens === "number") {
        this.#cacheWriteTokens += usage.cacheWriteTokens;
      }
    }

    const mapped = mapDshSessionEvent(value, this.#toolNames);
    for (const event of mapped.events) this.#emit(event);
    if (mapped.message) {
      this.#messages.push(mapped.message);
      this.#persist("message", mapped.message);
    }
    if (mapped.assistantText !== undefined) {
      this.#lastAssistant = mapped.assistantText;
    }
  }

  #consumeNotification(notification: HarnessNotification): void {
    if (notification.method !== "session.event") return;
    const params = record(notification.params);
    if (params.sessionId !== this.runtimeSessionId) return;
    const event = record(params.event);
    if (typeof event.type !== "string") return;
    this.#consume(event as DshSessionEventLike);
  }

  async #engine(): Promise<DshHarnessLike> {
    if (this.#closed) throw new Error("DeepSeek Harness session is closed.");
    const generation = this.#generation;
    if (!this.#harness) {
      const harness = await this.#createHarness(
        this.#model,
        this.#createOptions,
        (event) => this.#emit(event)
      );
      const ensureNotCancelled = async () => {
        if (
          !this.#closed &&
          !this.#abortRequested &&
          generation === this.#generation
        ) {
          return;
        }
        await harness.close().catch(() => {});
        throw new Error(
          "DeepSeek Harness session was cancelled during initialization."
        );
      };
      await ensureNotCancelled();
      harness.client.onRequest(async (method, params) => {
        if (method !== "approval/request") {
          throw new Error(`Unsupported DeepSeek Harness request: ${method}`);
        }
        const handler = this.#createOptions.permissionHandler;
        if (!handler) return { outcome: "rejected" };
        const permissionId = randomUUID();
        const toolCallId =
          typeof params.callId === "string"
            ? params.callId
            : `dsh-${permissionId}`;
        const request = {
          permissionId,
          toolName:
            typeof params.toolName === "string" ? params.toolName : "tool",
          toolCallId,
          argsSummary:
            typeof params.reason === "string" ? params.reason : undefined,
          risk: "standard" as const,
        };
        const requestApproval = async () => {
          this.#emit({
            type: "permission_requested",
            permissionId,
            toolName: request.toolName,
            toolCallId,
            ...(request.argsSummary
              ? { argsSummary: request.argsSummary }
              : {}),
            risk: request.risk,
          });
          return await handler.request(request);
        };
        if (handler.preflight) {
          const decision = await handler.preflight(request);
          if (decision === "allow") return { outcome: "allowed-once" };
          if (decision === "deny") return { outcome: "rejected" };
        }
        const decision = await requestApproval();
        return {
          outcome: decision === "allow" ? "allowed-once" : "rejected",
        };
      });
      if (this.#resumePending) {
        await harness.resumeSession(this.runtimeSessionId);
        await ensureNotCancelled();
        this.#resumePending = false;
      }
      this.#harness = harness;
    }
    return this.#harness;
  }

  async #run(input: string | unknown[]): Promise<void> {
    if (this.#active)
      throw new Error("DeepSeek Harness session is already running.");
    this.#active = true;
    try {
      const harness = await this.#engine();
      const result = await harness.session(this.runtimeSessionId).run(input, {
        onNotification: (notification) =>
          this.#consumeNotification(notification),
      });
      for (const event of result.events) this.#consume(event);
      this.#emit({ type: "session_end", text: "" });
    } catch (error) {
      if (!this.#abortRequested) {
        this.#emit({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      this.#active = false;
      this.#abortRequested = false;
    }
  }

  async prompt(input: string | PromptInput): Promise<void> {
    const normalized = asPromptInput(input);
    const message: RuntimeMessage = {
      id: randomUUID(),
      role: "user",
      text: normalized.text,
      ...(normalized.files?.length
        ? {
            attachments: normalized.files.map((file) => ({
              mediaType: file.mediaType,
            })),
          }
        : {}),
    };
    this.#messages.push(message);
    this.#persist("message", message);
    await this.#run(await promptBlocks(normalized));
  }

  async steer(text: string): Promise<void> {
    const harness = await this.#engine();
    await harness.client.prompt(this.runtimeSessionId, [
      { type: "text", text },
    ]);
    const message: RuntimeMessage = {
      id: randomUUID(),
      role: "user",
      text,
    };
    this.#messages.push(message);
    this.#persist("message", message);
  }

  async followUp(text: string): Promise<void> {
    await this.steer(text);
  }

  async abort(): Promise<void> {
    const wasActive = this.#active;
    this.#abortRequested = wasActive;
    const harness = this.#harness;
    this.#harness = undefined;
    this.#resumePending = true;
    this.#active = false;
    await harness?.close().catch(() => {});
    if (wasActive) this.#emit({ type: "interrupted" });
  }

  async stopToolCall(_toolCallId: string): Promise<void> {
    throw unsupported("stopping one tool call");
  }

  subscribe(listener: (event: NormalizedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  lastAssistantText(): string {
    return this.#lastAssistant;
  }

  toolNames(): string[] {
    return [...new Set(this.#toolNames.values())];
  }

  async compact(_customInstructions?: string): Promise<void> {
    await this.#run([{ type: "text", text: "/compact" }]);
  }

  exportSession(): Promise<RuntimeExport> {
    const jsonl = this.#events.map((event) => JSON.stringify(event)).join("\n");
    return Promise.resolve({
      jsonl,
      html: `<pre>${htmlEscape(jsonl)}</pre>`,
    });
  }

  messages(): RuntimeMessage[] {
    return this.#messages.map((message) => ({ ...message }));
  }

  currentModel(): RuntimeModelRef {
    return { ...this.#model };
  }

  async setModel(model: RuntimeModelRef): Promise<void> {
    if (this.#active)
      throw new Error("Cannot change model while a prompt is running.");
    if (model.providerId !== this.#provider) {
      throw new Error(
        `DeepSeek Harness runtime is configured for ${this.#provider}, not ${model.providerId}.`
      );
    }
    const harness = this.#harness;
    this.#harness = undefined;
    this.#resumePending = true;
    await harness?.close().catch(() => {});
    this.#model = { ...model };
  }

  async setThinkingLevel(_level: ThinkingLevel): Promise<void> {
    throw unsupported("changing thinking level per session");
  }

  getThinkingInfo() {
    return {
      level: "off" as const,
      availableLevels: ["off"] as ThinkingLevel[],
      supportsThinking: false,
    };
  }

  getContextUsage(): Promise<ThebeSessionContext> {
    return Promise.resolve({
      contextUsage: {
        usedTokens: this.#totalTokens,
        maxTokens: DEFAULT_CONTEXT_WINDOW,
      },
      compaction: { nearThreshold: false },
      sessionStats: {
        sessionId: this.runtimeSessionId,
        userMessages: this.#messages.filter(
          (message) => message.role === "user"
        ).length,
        assistantMessages: this.#messages.filter(
          (message) => message.role === "assistant"
        ).length,
        toolCalls: this.#toolNames.size,
        toolResults: this.#messages.filter((message) => message.role === "tool")
          .length,
        totalMessages: this.#messages.length,
        tokens: {
          input: this.#inputTokens,
          output: this.#outputTokens,
          cacheRead: this.#cacheReadTokens,
          cacheWrite: this.#cacheWriteTokens,
          total: this.#totalTokens,
        },
        cost: 0,
      },
    });
  }

  listBackgroundTasks(): Promise<BackgroundTask[]> {
    return Promise.resolve([]);
  }

  async stopBackgroundTask(_taskId: string): Promise<void> {
    throw new Error(
      "DeepSeek Harness SDK exposes no background-task stop operation."
    );
  }

  async revert(): Promise<void> {
    throw unsupported("revert");
  }

  async unrevert(): Promise<void> {
    throw unsupported("unrevert");
  }

  dispose(): void {
    if (this.#closed) return;
    this.#abortRequested = this.#active;
    this.#closed = true;
    this.#disposeSession?.();
    const harness = this.#harness;
    this.#harness = undefined;
    void harness?.close().catch(() => {});
    this.#listeners.clear();
  }

  async close(): Promise<void> {
    this.dispose();
  }

  async suspend(): Promise<void> {
    this.#generation += 1;
    const harness = this.#harness;
    if (!harness) return;
    this.#harness = undefined;
    this.#resumePending = true;
    await harness.close().catch(() => {});
  }

  isRunning(): boolean {
    return this.#active;
  }

  credentialsChanged(): void {
    const harness = this.#harness;
    this.#harness = undefined;
    this.#resumePending = true;
    void harness?.close().catch(() => {});
  }
}

export function createDeepSeekHarnessRuntime(
  options: DeepSeekHarnessRuntimeOptions
): DeepSeekHarnessRuntime {
  const cwd = resolve(options.cwd);
  const sessionRoot = resolve(options.sessionRoot);
  const provider = options.provider?.trim() || DEFAULT_PROVIDER;
  const env = options.env ?? process.env;
  const modelIds = [
    ...new Set(
      options.models ??
        env.THEBE_DSH_MODELS?.split(",")
          .map((value) => value.trim())
          .filter(Boolean) ??
        DEFAULT_MODELS
    ),
  ];
  const defaultModel = options.model?.trim() || modelIds[0]!;
  let apiKey = options.apiKey?.trim() || env.DEEPSEEK_API_KEY?.trim();
  const currentModel: RuntimeModelRef = {
    providerId: provider,
    modelId: defaultModel,
  };
  const live = new Map<string, DshRuntimeSession>();
  const liveness = new Map<string, () => boolean>();
  let quiesced = false;
  let coreMcp = options.coreMcp;
  let unregisterSessionMcp: ((sessionId: string) => void) | undefined;

  function dshEnvironment(): NodeJS.ProcessEnv {
    const scrubbed = sanitizeBashEnv(env);
    return {
      ...scrubbed,
      ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {}),
      ...(coreMcp
        ? {
            CORE_MCP_BRIDGE_TOKEN: coreMcp.token,
          }
        : {}),
      ...(options.disableDshSandbox
        ? { DSH_PERMISSION_MODE: "danger-full-access" }
        : {}),
    };
  }

  const harnessFactory: DshHarnessFactory =
    options.harnessFactory ??
    (async (input) => {
      const { DeepSeekHarness } = await import("@deepseek-ai/dsh-sdk-client");
      return new DeepSeekHarness({
        cwd: input.cwd,
        dshHome: input.home,
        profile: "sdk",
        provider: input.provider,
        model: input.model,
        approvalRequests: true,
        env: input.env,
        ...(input.patches ? { patches: input.patches } : {}),
        onUserQuestion: async () => ({ cancelled: true }),
      });
    });

  async function createHarness(
    runtimeSessionId: string,
    home: string,
    model: RuntimeModelRef,
    create: CreateRuntimeSessionOptions,
    emit: (event: NormalizedEvent) => void
  ): Promise<DshHarnessLike> {
    const sessionCwd = resolve(create.cwd ?? cwd);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const patchLines = [
      "# Thebe keeps its own permission handler in control.",
      "- id: approval",
      "  config:",
      "    policy: ask",
    ];
    if (create.systemPrompt?.trim()) {
      const prompt =
        create.customTools.length > 0
          ? `${create.systemPrompt}\n\nCore capabilities are mounted through the DeepSeek Harness MCP server named "thebe_session_tools". Load its tool catalog with the Harness tool-discovery mechanism and honor each MCP tool's permission hints. Do not invent a Core tool that is absent from that server.`
          : create.systemPrompt;
      patchLines.push(
        "- id: system-prompt",
        "  config:",
        "    includeHarnessIdentity: true",
        `    personaPrefix: ${JSON.stringify(prompt)}`
      );
    }
    patchLines.push(...disabledToolRows(create.builtinTools));
    if (create.customTools.length > 0) {
      if (!coreMcp?.registerSession) {
        throw new Error(
          "DeepSeek Harness cannot expose session tools without the Core MCP bridge."
        );
      }
      const sessionMcp = coreMcp.registerSession(runtimeSessionId, {
        customTools: create.customTools,
        ...(create.permissionHandler
          ? { permissionHandler: create.permissionHandler }
          : {}),
        ...(create.toolsRequiringApproval
          ? { toolsRequiringApproval: create.toolsRequiringApproval }
          : {}),
        emit,
      });
      patchLines.push(
        "- insert:",
        "    - id: thebe-session-tools",
        "      name: '@deepseek-ai/dsh-mcp-client'",
        "      config:",
        "        transport: streamable-http",
        "        serverName: thebe_session_tools",
        `        url: ${JSON.stringify(sessionMcp.url)}`,
        "        headers:",
        '          Authorization: "Bearer ${credential:CORE_MCP_BRIDGE_TOKEN}"',
        "        toolCallTimeoutMs: 60000",
        "        closeTimeoutMs: 5000",
        "        expandTemplates: true",
        "        failOnStartupError: true",
        "        toolLoading: on-demand",
        "        catalogDescriptionMaxLength: 160"
      );
    }
    const patch = join(home, "thebe-runtime.patch.yml");
    await writeFile(patch, `${patchLines.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return harnessFactory({
      sessionId: runtimeSessionId,
      home,
      cwd: sessionCwd,
      provider: model.providerId,
      model: model.modelId,
      ...(apiKey ? { apiKey } : {}),
      env: dshEnvironment(),
      patches: [patch],
    });
  }

  async function open(
    runtimeSessionId: string,
    create: CreateRuntimeSessionOptions,
    resume: boolean
  ): Promise<RuntimeSession> {
    const home = create.inMemory
      ? await mkdtemp(join(tmpdir(), "thebe-dsh-"))
      : join(sessionRoot, runtimeSessionId);
    if (!create.inMemory) {
      await mkdir(home, { recursive: true, mode: 0o700 });
    }
    let session!: DshRuntimeSession;
    try {
      session = new DshRuntimeSession({
        runtimeSessionId,
        transcriptPath: join(home, "thebe-transcript.jsonl"),
        provider,
        resume,
        create,
        getModel: () => ({ ...currentModel }),
        createHarness: (model, create, emit) =>
          createHarness(runtimeSessionId, home, model, create, emit),
        disposeSession: () => {
          if (live.get(runtimeSessionId) === session) {
            live.delete(runtimeSessionId);
          }
          liveness.delete(runtimeSessionId);
          unregisterSessionMcp?.(runtimeSessionId);
          if (create.inMemory) {
            try {
              rmSync(home, { recursive: true, force: true });
            } catch {
              // Temporary homes are best-effort cleanup after their harness closes.
            }
          }
        },
      });
    } catch (error) {
      if (create.inMemory) {
        try {
          rmSync(home, { recursive: true, force: true });
        } catch {
          // Keep the session initialization error as the primary failure.
        }
      }
      throw error;
    }
    await session.loadTranscript();
    live.set(runtimeSessionId, session);
    return session;
  }

  function models(): RuntimeModel[] {
    return modelIds.map((modelId) => ({
      providerId: provider,
      modelId,
      displayName: modelDisplayName(modelId),
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      supportsImages: true,
      supportsThinking: false,
      available: Boolean(apiKey),
    }));
  }

  const auth: RuntimeAuth = {
    async setApiKey(providerId: string, key: string) {
      if (!["deepseek", "deepseek-official", "dsh"].includes(providerId)) {
        throw new Error(
          `DeepSeek Harness runtime does not own provider "${providerId}".`
        );
      }
      apiKey = key.trim() || undefined;
      for (const session of live.values()) session.credentialsChanged();
    },
    async loginOAuth(): Promise<never> {
      throw unsupported("OAuth login through the SDK client");
    },
    async authorizeOAuth(): Promise<never> {
      throw unsupported("OAuth authorization through the SDK client");
    },
    async submitOAuthCallback(): Promise<never> {
      throw unsupported("OAuth callback submission through the SDK client");
    },
    async logout(providerId: string) {
      if (!["deepseek", "deepseek-official", "dsh"].includes(providerId))
        return;
      apiKey = undefined;
      for (const session of live.values()) session.credentialsChanged();
    },
    async check(providerId: string) {
      return {
        ok:
          ["deepseek", "deepseek-official", "dsh"].includes(providerId) &&
          Boolean(apiKey),
      };
    },
    async listProviders(): Promise<RuntimeProvider[]> {
      return [
        {
          id: provider,
          displayName: "DeepSeek Harness",
          authMethods: ["apiKey"],
          authStatus: apiKey ? "connected" : "missing",
        },
      ];
    },
    async testProvider(providerId: string) {
      return {
        ok:
          ["deepseek", "deepseek-official", "dsh"].includes(providerId) &&
          Boolean(apiKey),
        ...(!apiKey ? { message: "DEEPSEEK_API_KEY is not configured" } : {}),
      };
    },
  };

  return {
    runtimeId: DSH_RUNTIME_ID,
    mountCoreMcp(input) {
      coreMcp = { ...input };
      unregisterSessionMcp = input.unregisterSession;
      for (const session of live.values()) session.credentialsChanged();
    },
    createSession(create) {
      if (quiesced) throw new Error("DeepSeek Harness runtime is quiesced.");
      return open(sessionId(), create, false);
    },
    resumeSession(runtimeSessionId, create) {
      if (quiesced) throw new Error("DeepSeek Harness runtime is quiesced.");
      return open(runtimeSessionId, create, true);
    },
    async listSessions() {
      let names: string[];
      try {
        names = await readdir(sessionRoot);
      } catch {
        return [];
      }
      return names
        .filter((runtimeSessionId) => runtimeSessionId.startsWith("session-"))
        .map((runtimeSessionId) => ({ runtimeSessionId }));
    },
    async deleteSession(runtimeSessionId) {
      const session = live.get(runtimeSessionId);
      live.delete(runtimeSessionId);
      liveness.delete(runtimeSessionId);
      await session?.close().catch(() => {});
      await rm(join(sessionRoot, runtimeSessionId), {
        recursive: true,
        force: true,
      });
    },
    async forkSession(): Promise<never> {
      throw unsupported("fork");
    },
    async listModels() {
      return models();
    },
    async listAvailableModels(query) {
      return models().filter(
        (model) =>
          model.available &&
          (!query?.providerId || model.providerId === query.providerId)
      );
    },
    async listProviders() {
      return auth.listProviders();
    },
    auth() {
      return auth;
    },
    async quiesce() {
      quiesced = true;
      await Promise.all(
        [...live.values()].map(async (session) => {
          await session.suspend();
        })
      );
    },
    async unquiesce() {
      quiesced = false;
    },
    isQuiesced() {
      return quiesced;
    },
    registerSessionLiveness(sessionId, isActive) {
      liveness.set(sessionId, isActive);
      return () => {
        if (liveness.get(sessionId) === isActive) {
          liveness.delete(sessionId);
        }
      };
    },
    reapInactiveSessions() {
      let reaped = 0;
      for (const [sessionId, session] of live) {
        if (liveness.get(sessionId)?.() === true || session.isRunning()) {
          continue;
        }
        live.delete(sessionId);
        liveness.delete(sessionId);
        session.dispose();
        reaped += 1;
      }
      return reaped;
    },
  };
}
