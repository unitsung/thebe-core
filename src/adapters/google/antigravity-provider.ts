import {
  ANTIGRAVITY_CLIENTS,
  ANTIGRAVITY_PROVIDER_ID,
  CLIENT_METADATA,
  CODE_ASSIST_CLIENT_HEADER,
  CODE_ASSIST_ENDPOINT,
  codeAssistError,
  generateContentBody,
  methodUrl,
  type AntigravityClientKind,
  type AntigravityCredential,
  type FetchLike,
} from "./antigravity.ts";

/**
 * Pi provider for Antigravity (Google Cloud Code Assist).
 *
 * Pi removed its built-in Gemini CLI / Antigravity support in 0.71 and leaves
 * custom providers to `registerProvider`. Core registers this provider on the
 * ModelRuntime it hands to `createAgentSession`, which is what makes
 * `provider: "google-antigravity"` usable inside Pi sessions:
 *
 * - models: a known baseline plus a `fetchModels` overlay from
 *   `v1internal:fetchAvailableModels` (published to the model store).
 * - auth: `apiKey.resolve` reads Core's own credential file, so Pi and the
 *   HTTP/TUI surfaces share one Google session and logout revokes it.
 * - transport: `v1internal:streamGenerateContent?alt=sse` with the Cloud Code
 *   Assist envelope, reusing pi-ai's Gemini converters for messages and tools.
 *
 * The pi-ai helpers are injected: they are loaded from Pi's own dependency
 * tree at runtime (see `loadAntigravityPiAi`), so Core keeps a single Pi
 * package dependency and never bundles a duplicate pi-ai.
 */

export type AntigravityPiModel = {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

export type AntigravityEvent = { type: string } & Record<string, unknown>;

export type AntigravityPiAi = {
  createProvider: (input: Record<string, unknown>) => unknown;
  createAssistantMessageEventStream: () => unknown;
  calculateCost: (model: AntigravityPiModel, usage: Record<string, unknown>) => void;
  clampThinkingLevel: (model: AntigravityPiModel, level: string) => string;
  convertMessages: (model: AntigravityPiModel, context: unknown) => unknown[];
  convertTools: (
    tools: readonly unknown[],
    useParameters?: boolean,
    supportsStrictMode?: boolean,
  ) => unknown;
  resolveGoogleFunctionCallingMode: (
    tools: readonly unknown[],
    toolChoice?: string,
    supportsStrictMode?: boolean,
  ) => string | undefined;
  supportsGoogleStrictToolSampling: (modelId: string) => boolean;
  isThinkingPart: (part: unknown) => boolean;
  retainThoughtSignature: (
    existing: string | undefined,
    incoming: string | undefined,
  ) => string | undefined;
  mapStopReason: (reason: string) => string;
  resolveGoogleThinkingLevel: (model: AntigravityPiModel, level: string) => string;
  /** pi-ai decides the Google wire format for thinking from the model's level map. */
  usesGoogleThinkingLevel: (model: AntigravityPiModel) => boolean;
  toGoogleThinkingLevel: (level: string) => string;
  getDisabledGoogleThinkingConfig: (model: AntigravityPiModel) => Record<string, unknown>;
  /** Transcript helpers: the prompt and tools live in normalized messages. */
  collapseSystemMessages: (context: AntigravityContext) => AntigravityContext;
  getCurrentSystemPrompt: (messages: readonly unknown[]) => string;
  getCurrentTools: (messages: readonly unknown[]) => unknown[];
  retryGoogleRequest: <T>(request: () => Promise<T>, options: unknown) => Promise<T>;
  buildBaseOptions: (
    model: AntigravityPiModel,
    context: unknown,
    options: Record<string, unknown> | undefined,
    apiKey?: string,
  ) => Record<string, unknown>;
  thinkingBudgetForLevel: (level: string, budgets?: unknown) => number | undefined;
};

/** Loaded lazily so Core resolves one pi-ai copy (the agent's own). */
export async function loadAntigravityPiAi(
  distUrl: (rel: string) => string,
): Promise<AntigravityPiAi> {
  const root = (await import(distUrl("index.js"))) as Record<string, unknown>;
  const shared = (await import(distUrl("api/google-shared.js"))) as Record<string, unknown>;
  const simple = (await import(distUrl("api/simple-options.js"))) as Record<string, unknown>;
  return {
    createProvider: root.createProvider,
    createAssistantMessageEventStream: root.createAssistantMessageEventStream,
    calculateCost: root.calculateCost,
    clampThinkingLevel: root.clampThinkingLevel,
    convertMessages: shared.convertMessages,
    convertTools: shared.convertTools,
    resolveGoogleFunctionCallingMode: shared.resolveGoogleFunctionCallingMode,
    supportsGoogleStrictToolSampling: shared.supportsGoogleStrictToolSampling,
    isThinkingPart: shared.isThinkingPart,
    retainThoughtSignature: shared.retainThoughtSignature,
    mapStopReason: shared.mapStopReason,
    resolveGoogleThinkingLevel: shared.resolveGoogleThinkingLevel,
    usesGoogleThinkingLevel: shared.usesGoogleThinkingLevel,
    toGoogleThinkingLevel: shared.toGoogleThinkingLevel,
    getDisabledGoogleThinkingConfig: shared.getDisabledGoogleThinkingConfig,
    collapseSystemMessages: root.collapseSystemMessages,
    getCurrentSystemPrompt: root.getCurrentSystemPrompt,
    getCurrentTools: root.getCurrentTools,
    retryGoogleRequest: shared.retryGoogleRequest,
    buildBaseOptions: simple.buildBaseOptions,
    thinkingBudgetForLevel: simple.thinkingBudgetForLevel,
  } as unknown as AntigravityPiAi;
}

/**
 * Metadata for model ids Antigravity hands out, so names, limits, and thinking
 * mode stay consistent. The authoritative list comes from
 * `fetchAvailableModels`; ids outside this table fall back to title casing.
 */
export type AntigravityModelSeed = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** Gemini 3 exposes level-based thinking; 2.x uses budgets. */
  levels: boolean;
};

export const ANTIGRAVITY_KNOWN_MODELS: AntigravityModelSeed[] = [
  { id: "gemini-3-pro", name: "Gemini 3 Pro", contextWindow: 1_048_576, maxTokens: 65_536, levels: true },
  { id: "gemini-3-pro-high", name: "Gemini 3 Pro High", contextWindow: 1_048_576, maxTokens: 65_536, levels: true },
  { id: "gemini-3-pro-low", name: "Gemini 3 Pro Low", contextWindow: 1_048_576, maxTokens: 65_536, levels: true },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", contextWindow: 1_048_576, maxTokens: 65_536, levels: true },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_048_576, maxTokens: 65_536, levels: false },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_048_576, maxTokens: 65_536, levels: false },
];

/**
 * Offline seed: what the provider offers before any account listing landed.
 * Kept deliberately small — Pi merges the published list on top of the
 * baseline, so extra entries would linger as noise in every picker.
 */
export const ANTIGRAVITY_BASELINE_IDS = ["gemini-3-pro", "gemini-3-flash"];

/**
 * Gemini 3 thinking levels, matching pi's own Google model definitions: the
 * four levels map to themselves, `off` is unsupported (thinking cannot be
 * disabled), and `xhigh`/`max` stay hidden.
 */
const GEMINI3_THINKING_LEVELS: Record<string, string | null> = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
};

function modelName(id: string): string {
  const known = ANTIGRAVITY_KNOWN_MODELS.find((seed) => seed.id === id);
  if (known) return known.name;
  return id
    .split("-")
    .map((part) => {
      const head = part.charAt(0).toUpperCase();
      return part.length > 0 ? `${head}${part.slice(1)}` : part;
    })
    .join(" ");
}

export function antigravityModelObjects(deps: {
  providerId: string;
  endpoint: string;
  models: Array<{ id: string; displayName?: string }>;
}): AntigravityPiModel[] {
  return deps.models.map((entry) => {
    const seed = ANTIGRAVITY_KNOWN_MODELS.find((candidate) => candidate.id === entry.id);
    const levels = seed?.levels ?? /gemini-3/.test(entry.id);
    return {
      id: entry.id,
      name: entry.displayName ?? seed?.name ?? modelName(entry.id),
      api: "google-generative-ai",
      provider: deps.providerId,
      baseUrl: deps.endpoint,
      reasoning: true,
      ...(levels ? { thinkingLevelMap: GEMINI3_THINKING_LEVELS } : {}),
      input: ["text", "image"] as ("text" | "image")[],
      // Antigravity is subscription-backed: no per-token billing to report.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: seed?.contextWindow ?? 1_048_576,
      maxTokens: seed?.maxTokens ?? 65_536,
    };
  });
}

// MARK: - Request

export type AntigravityContext = {
  /** Normalized transcript: system prompt and tools travel as messages. */
  messages: unknown[];
};

export type AntigravityRequestOptions = Record<string, unknown> & {
  apiKey?: string;
  headers?: Record<string, string | null>;
  signal?: AbortSignal;
  toolChoice?: string;
  reasoning?: string;
  maxTokens?: number;
  temperature?: number;
  samplingParams?: Record<string, unknown>;
  thinkingBudgets?: unknown;
};

/** Antigravity's thinking knobs are the Gemini ones: levels on 3.x, budgets below. */
export function antigravityThinkingConfig(
  piAi: AntigravityPiAi,
  model: AntigravityPiModel,
  options: AntigravityRequestOptions,
): Record<string, unknown> | undefined {
  if (!model.reasoning) return undefined;
  const level = typeof options.reasoning === "string" ? options.reasoning : undefined;
  if (level === undefined) return undefined;
  if (level === "off") {
    // Gemini 3.x cannot fully disable thinking; pi's helper picks the lowest
    // supported level (or budget 0) for the model, matching its Google adapter.
    return piAi.getDisabledGoogleThinkingConfig(model);
  }
  const clamped = piAi.clampThinkingLevel(model, level);
  const resolved = piAi.resolveGoogleThinkingLevel(model, clamped);
  if (piAi.usesGoogleThinkingLevel(model)) {
    return { includeThoughts: true, thinkingLevel: piAi.toGoogleThinkingLevel(resolved) };
  }
  const budget = piAi.thinkingBudgetForLevel(clamped, options.thinkingBudgets);
  return budget === undefined
    ? { includeThoughts: true }
    : { includeThoughts: true, thinkingBudget: budget };
}

function samplingFrom(options: AntigravityRequestOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof options.temperature === "number") out.temperature = options.temperature;
  const sampling = options.samplingParams;
  if (sampling) {
    for (const key of ["temperature", "topP", "topK"] as const) {
      if (typeof sampling[key] === "number") out[key] = sampling[key];
    }
  }
  return out;
}

/** `v1internal:streamGenerateContent` request: envelope around a Gemini body. */
export function antigravityRequest(args: {
  piAi: AntigravityPiAi;
  model: AntigravityPiModel;
  context: AntigravityContext;
  options: AntigravityRequestOptions;
  credential: AntigravityCredential;
  endpoint?: string;
}): { url: string; body: Record<string, unknown> } {
  const { piAi, model, context, options, credential } = args;
  const projectId = credential.projectId;
  if (!projectId) {
    throw new Error("no Cloud project resolved for this Google account");
  }
  // Gemini carries the prompt and tools outside the message list: replay the
  // transcript's system messages into one prompt and read the current tools.
  const messages = context.messages;
  const systemPrompt = piAi.getCurrentSystemPrompt(messages);
  const tools = piAi.getCurrentTools(messages);
  const supportsStrict = piAi.supportsGoogleStrictToolSampling(model.id);
  const functionCallingMode = tools.length
    ? piAi.resolveGoogleFunctionCallingMode(tools, options.toolChoice, supportsStrict)
    : undefined;
  const thinkingConfig = antigravityThinkingConfig(piAi, model, options);
  const generationConfig: Record<string, unknown> = {
    ...samplingFrom(options),
    ...(typeof options.maxTokens === "number" ? { maxOutputTokens: options.maxTokens } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
  const request = {
    contents: piAi.convertMessages(model, piAi.collapseSystemMessages(context)),
    ...(systemPrompt
      ? { systemInstruction: { parts: [{ text: systemPrompt }] } }
      : {}),
    ...(tools.length
      ? {
          tools: piAi.convertTools(
            tools,
            // Cloud Code Assist translates `parameters` into Anthropic's
            // input_schema for its Claude models.
            /claude/i.test(model.id),
            supportsStrict,
          ),
        }
      : {}),
    ...(functionCallingMode
      ? { toolConfig: { functionCallingConfig: { mode: functionCallingMode } } }
      : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
  return {
    url: `${methodUrl("streamGenerateContent", args.endpoint ?? CODE_ASSIST_ENDPOINT)}?alt=sse`,
    body: generateContentBody({ projectId, model: model.id, request }),
  };
}

function codeAssistHeaders(
  credential: AntigravityCredential,
  kind: AntigravityClientKind,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "User-Agent": ANTIGRAVITY_CLIENTS[kind].userAgent,
    "X-Goog-Api-Client": CODE_ASSIST_CLIENT_HEADER,
    "Client-Metadata": CLIENT_METADATA,
  };
}

// MARK: - Response

export type AntigravityChunk = {
  candidates?: Array<{ content?: { parts?: unknown[] }; finishReason?: string }>;
  usageMetadata?: Record<string, number>;
  responseId?: string;
};

/** Cloud Code Assist wraps every Gemini response in a `response` envelope. */
export function antigravityChunkFromPayload(payload: unknown): AntigravityChunk | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const inner = (
    record.response && typeof record.response === "object" ? record.response : record
  ) as Record<string, unknown>;
  const isChunk =
    Array.isArray(inner.candidates) ||
    inner.usageMetadata !== undefined ||
    typeof inner.responseId === "string";
  return isChunk ? (inner as AntigravityChunk) : undefined;
}

/**
 * Split an SSE buffer into complete `data:` payloads plus the incomplete tail,
 * so a caller can feed arbitrary network chunks through it.
 */
export function splitSseFrames(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n");
  const rest = frames.pop() ?? "";
  for (const frame of frames) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (data.length > 0) payloads.push(data);
  }
  return { payloads, rest };
}

export type AntigravityBlock =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown; thoughtSignature?: string };

/** Part blocks that a single stream can be in the middle of. */
export type AntigravityPartBlock =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string };

export type AntigravityStream = AsyncIterable<unknown>;

export type AntigravityOutput = {
  role: "assistant";
  content: AntigravityBlock[];
  api: string;
  provider: string;
  model: string;
  usage: Record<string, unknown> & {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: Record<string, number>;
  };
  stopReason: string;
  rawStopReason?: string;
  responseId?: string;
  errorMessage?: string;
  timestamp: number;
};

export type AntigravityStreamState = {
  output: AntigravityOutput;
  current: AntigravityPartBlock | undefined;
};

export function createAntigravityState(model: AntigravityPiModel): AntigravityStreamState {
  return {
    current: undefined,
    output: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    },
  };
}

let toolCallCounter = 0;

/** Turn one Gemini chunk into Pi stream events, mutating `state.output`. */
export function applyAntigravityChunk(args: {
  piAi: AntigravityPiAi;
  model: AntigravityPiModel;
  state: AntigravityStreamState;
  chunk: AntigravityChunk;
  send: (event: AntigravityEvent) => void;
}): void {
  const { piAi, state, chunk, send } = args;
  const { output } = state;
  const index = () => output.content.length - 1;
  const endCurrent = () => {
    const block = state.current;
    if (!block) return;
    if (block.type === "text") {
      send({ type: "text_end", contentIndex: index(), content: block.text, partial: output });
    } else {
      send({
        type: "thinking_end",
        contentIndex: index(),
        content: block.thinking,
        partial: output,
      });
    }
    state.current = undefined;
  };

  output.responseId ||= chunk.responseId;

  const candidate = chunk.candidates?.[0];
  for (const rawPart of candidate?.content?.parts ?? []) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as Record<string, unknown>;

    if (typeof part.text === "string") {
      const isThinking = piAi.isThinkingPart(part);
      if (
        !state.current ||
        (isThinking && state.current.type !== "thinking") ||
        (!isThinking && state.current.type !== "text")
      ) {
        endCurrent();
        state.current = isThinking
          ? { type: "thinking", thinking: "" }
          : { type: "text", text: "" };
        output.content.push(state.current);
        send({
          type: isThinking ? "thinking_start" : "text_start",
          contentIndex: index(),
          partial: output,
        });
      }
      const block = state.current;
      if (block.type === "thinking") {
        block.thinking += part.text;
        block.thinkingSignature = piAi.retainThoughtSignature(
          block.thinkingSignature,
          typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined,
        );
        send({
          type: "thinking_delta",
          contentIndex: index(),
          delta: part.text,
          partial: output,
        });
      } else {
        block.text += part.text;
        block.textSignature = piAi.retainThoughtSignature(
          block.textSignature,
          typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined,
        );
        send({ type: "text_delta", contentIndex: index(), delta: part.text, partial: output });
      }
    }

    const functionCall = part.functionCall;
    if (functionCall && typeof functionCall === "object") {
      endCurrent();
      const call = functionCall as Record<string, unknown>;
      const name = typeof call.name === "string" ? call.name : "";
      const providedId = typeof call.id === "string" ? call.id : undefined;
      const duplicate = providedId
        ? output.content.some((block) => block.type === "toolCall" && block.id === providedId)
        : true;
      const toolCall: AntigravityBlock = {
        type: "toolCall",
        id: duplicate ? `${name}_${Date.now()}_${++toolCallCounter}` : (providedId as string),
        name,
        arguments: call.args ?? {},
        ...(typeof part.thoughtSignature === "string"
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
      };
      output.content.push(toolCall);
      send({ type: "toolcall_start", contentIndex: index(), partial: output });
      send({
        type: "toolcall_delta",
        contentIndex: index(),
        delta: JSON.stringify(toolCall.arguments),
        partial: output,
      });
      send({ type: "toolcall_end", contentIndex: index(), toolCall, partial: output });
    }
  }

  if (candidate?.finishReason) {
    output.rawStopReason = candidate.finishReason;
    output.stopReason = piAi.mapStopReason(candidate.finishReason);
    if (
      output.content.some((block) => block.type === "toolCall") &&
      output.stopReason === "stop"
    ) {
      output.stopReason = "toolUse";
    }
  }

  const usage = chunk.usageMetadata;
  if (usage) {
    const cached = usage.cachedContentTokenCount ?? 0;
    const thoughts = usage.thoughtsTokenCount ?? 0;
    output.usage = {
      input: (usage.promptTokenCount ?? 0) - cached,
      output: (usage.candidatesTokenCount ?? 0) + thoughts,
      cacheRead: cached,
      cacheWrite: 0,
      reasoning: thoughts,
      totalTokens: usage.totalTokenCount ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    piAi.calculateCost(args.model, output.usage);
  }
}

export function closeAntigravityOutput(
  state: AntigravityStreamState,
  send: (event: AntigravityEvent) => void,
): void {
  const block = state.current;
  if (block) {
    if (block.type === "text") {
      send({ type: "text_end", contentIndex: state.output.content.length - 1, content: block.text, partial: state.output });
    } else {
      send({
        type: "thinking_end",
        contentIndex: state.output.content.length - 1,
        content: block.thinking,
        partial: state.output,
      });
    }
    state.current = undefined;
  }
}

/** Read `alt=sse` frames through arbitrary network chunk boundaries. */
async function* ssePayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { payloads, rest } = splitSseFrames(buffer);
      buffer = rest;
      for (const payload of payloads) {
        if (payload === "[DONE]") continue;
        yield JSON.parse(payload) as unknown;
      }
    }
    for (const payload of splitSseFrames(`${buffer}\n\n`).payloads) {
      if (payload === "[DONE]") continue;
      yield JSON.parse(payload) as unknown;
    }
  } finally {
    reader.releaseLock();
  }
}

async function responseError(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {}
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const message = codeAssistError(payload);
    if (message) return message;
  } catch {}
  return text.trim().length > 0
    ? `HTTP ${response.status}: ${text.slice(0, 400)}`
    : `HTTP ${response.status}`;
}

export type AntigravityStreamDeps = {
  credential: (options?: { forceRefresh?: boolean }) => Promise<AntigravityCredential>;
  piAi: AntigravityPiAi;
  fetchImpl?: FetchLike;
  endpoint?: string;
};

function requestSignal(options: AntigravityRequestOptions): AbortSignal | undefined {
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : undefined;
  const signal = options.signal;
  if (timeoutMs === undefined || timeoutMs <= 0) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function headerOverrides(
  headers: AntigravityRequestOptions["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * One streamed turn against Cloud Code Assist, in Pi's event protocol. Pi
 * resolves auth before calling this, so a credential always exists here.
 */
export function streamAntigravity(
  deps: AntigravityStreamDeps,
  model: AntigravityPiModel,
  context: AntigravityContext,
  options: AntigravityRequestOptions,
): AntigravityStream {
  const { piAi } = deps;
  const stream = piAi.createAssistantMessageEventStream() as {
    push: (event: never) => void;
    end: (result?: never) => void;
  };
  const send = (event: AntigravityEvent) => stream.push(event as never);
  const state = createAntigravityState(model);
  const fetchImpl =
    (options.fetch as FetchLike | undefined) ??
    deps.fetchImpl ??
    ((input: string, init?: RequestInit) => fetch(input, init));

  void (async () => {
    try {
      const credential = await deps.credential();
      const request = antigravityRequest({
        piAi,
        model,
        context,
        options,
        credential,
        endpoint: deps.endpoint,
      });
      let body: unknown = request.body;
      const replaced = await (
        options.onPayload as
          | ((payload: unknown, model: AntigravityPiModel) => unknown | undefined)
          | undefined
      )?.(body, model);
      if (replaced !== undefined) body = replaced;

      const signal = requestSignal(options);
      const response = await piAi.retryGoogleRequest(
        () =>
          fetchImpl(request.url, {
            method: "POST",
            headers: {
              ...codeAssistHeaders(credential, credential.kind),
              ...headerOverrides(options.headers),
            },
            body: JSON.stringify(body),
            signal,
          }),
        {
          maxRetries: options.maxRetries,
          maxRetryDelayMs: options.maxRetryDelayMs,
          signal,
        },
      );
      await (
        options.onResponse as
          | ((response: { status: number; headers: Record<string, string> }, model: AntigravityPiModel) => unknown)
          | undefined
      )?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);

      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      send({ type: "start", partial: state.output });

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && response.body) {
        for await (const payload of ssePayloads(response.body)) {
          const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
          const error = codeAssistError(record);
          if (error) throw new Error(error);
          const chunk = antigravityChunkFromPayload(payload);
          if (chunk) {
            applyAntigravityChunk({ piAi, model, state, chunk, send });
          }
        }
      } else {
        const text = await response.text();
        const chunk = antigravityChunkFromPayload(
          text.trim().length > 0 ? (JSON.parse(text) as unknown) : undefined,
        );
        if (chunk) {
          applyAntigravityChunk({ piAi, model, state, chunk, send });
        }
      }

      closeAntigravityOutput(state, send);
      if (options.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (state.output.stopReason === "pending") {
        throw new Error("Antigravity stream ended without a finish reason");
      }
      if (state.output.stopReason === "aborted" || state.output.stopReason === "error") {
        throw new Error(
          state.output.rawStopReason
            ? `Provider stopped with: ${state.output.rawStopReason}`
            : "An unknown error occurred",
        );
      }
      send({ type: "done", reason: state.output.stopReason, message: state.output });
      stream.end();
    } catch (error) {
      state.output.stopReason = options.signal?.aborted ? "aborted" : "error";
      state.output.errorMessage = error instanceof Error ? error.message : String(error);
      send({ type: "error", reason: state.output.stopReason, error: state.output });
      stream.end();
    }
  })();

  return stream as unknown as AntigravityStream;
}

// MARK: - Provider

export type AntigravityProviderDeps = {
  piAi: AntigravityPiAi;
  /** Core's credential file: the single Google session shared with the app. */
  store: {
    get(providerId: string): AntigravityCredential | undefined;
  };
  credential: (options?: { forceRefresh?: boolean }) => Promise<AntigravityCredential>;
  /** `v1internal:fetchAvailableModels`, wrapped by the caller. */
  listModels: () => Promise<Array<{ id: string; displayName?: string }>>;
  fetchImpl?: FetchLike;
  endpoint?: string;
  providerId?: string;
};

const PROVIDER_NAME = "Antigravity (Google)";

/**
 * Build the Pi provider object. Register it with
 * `modelRuntime.registerNativeProvider(provider)` before creating sessions.
 */
export function createAntigravityProvider(deps: AntigravityProviderDeps): unknown {
  const providerId = deps.providerId ?? ANTIGRAVITY_PROVIDER_ID;
  const endpoint = deps.endpoint ?? CODE_ASSIST_ENDPOINT;
  const baseline = () =>
    antigravityModelObjects({
      providerId,
      endpoint,
      models: ANTIGRAVITY_BASELINE_IDS.map((id) => ({ id })),
    });
  const streamDeps: AntigravityStreamDeps = {
    credential: deps.credential,
    piAi: deps.piAi,
    fetchImpl: deps.fetchImpl,
    endpoint,
  };

  const streamSimple = (
    model: AntigravityPiModel,
    context: AntigravityContext,
    options?: Record<string, unknown>,
  ) =>
    streamAntigravity(
      streamDeps,
      model,
      context,
      {
        ...deps.piAi.buildBaseOptions(model, context, options, options?.apiKey as string | undefined),
        toolChoice: typeof options?.toolChoice === "string" ? options.toolChoice : undefined,
        reasoning: typeof options?.reasoning === "string" ? options.reasoning : undefined,
        thinkingBudgets: options?.thinkingBudgets,
      } as AntigravityRequestOptions,
    );

  return deps.piAi.createProvider({
    id: providerId,
    name: PROVIDER_NAME,
    baseUrl: endpoint,
    auth: {
      apiKey: {
        name: "Google account",
        // Side-effect free: status reads never refresh tokens.
        check: async () => {
          const stored = deps.store.get(providerId);
          if (!stored) return undefined;
          return { type: "api_key", source: stored.account ?? "Google account" };
        },
        // Per request: refresh the access token when it is about to expire and
        // resolve the Cloud project on first use.
        resolve: async () => {
          const credential = await deps.credential();
          return {
            auth: { apiKey: credential.accessToken },
            source: credential.account ? `Google account ${credential.account}` : "Google account",
          };
        },
      },
    },
    models: baseline(),
    // The account's real model list replaces the baseline once a refresh is
    // allowed; offline refreshes keep whatever was published before.
    fetchModels: async (context: { allowNetwork?: boolean; signal?: AbortSignal; stored?: { models?: unknown[] } }) => {
      const stored = (context.stored?.models ?? []).filter(
        (model): model is AntigravityPiModel =>
          !!model &&
          typeof model === "object" &&
          (model as AntigravityPiModel).provider === providerId,
      );
      if (!context.allowNetwork || context.signal?.aborted) {
        return stored.length > 0 ? stored : baseline();
      }
      if (!deps.store.get(providerId)) {
        return stored.length > 0 ? stored : baseline();
      }
      try {
        const available = await deps.listModels();
        return available.length > 0
          ? antigravityModelObjects({ providerId, endpoint, models: available })
          : stored.length > 0
            ? stored
            : baseline();
      } catch {
        return stored.length > 0 ? stored : baseline();
      }
    },
    api: { stream: streamSimple, streamSimple },
  });
}
