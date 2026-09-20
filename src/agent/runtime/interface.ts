/**
 * The Thebe-owned runtime seam.
 *
 * Agent and delivery code depend on these contracts, while concrete
 * runtimes adapt their own session, model, and event representations here.
 * Keep this module dependency-free so replacing the Pi adapter does not
 * change the contract seen by callers.
 */
export const PI_RUNTIME_ID = "pi-coding-agent";

export type NormalizedEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | {
      type: "tool_start";
      toolName: string;
      toolCallId: string;
      args?: unknown;
    }
  | {
      type: "tool_update";
      toolName: string;
      toolCallId: string;
      text?: string;
      args?: unknown;
    }
  | {
      type: "tool_end";
      toolName: string;
      toolCallId: string;
      isError: boolean;
      text: string;
      args?: unknown;
      details?: unknown;
    }
  | { type: "turn_end" }
  | { type: "session_end"; text: string }
  | { type: "error"; message: string }
  | { type: "compaction_start"; reason?: string }
  | {
      type: "compaction_end";
      aborted?: boolean;
      reason?: string;
      tokensBefore?: number;
      estimatedTokensAfter?: number;
      errorMessage?: string;
    }
  | { type: "interrupted" }
  | { type: "summary_ready"; summary: string; generatedAt: string }
  | { type: "queue_update"; steering: number; followUp: number }
  | {
      type: "permission_requested";
      permissionId: string;
      toolName: string;
      toolCallId: string;
      /** Redacted, truncated rendering of the tool input for the approval UI. */
      argsSummary?: string;
      /** Static risk hint: arbitrary-command tools are high, others standard. */
      risk?: "high" | "standard";
    }
  | {
      type: "tool_watchdog_timeout";
      toolCallId: string;
      toolName: string;
      elapsedMs: number;
    };

export type RuntimeMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  attachments?: Array<{ mediaType?: string }>;
  thinking?: string;
  args?: unknown;
  details?: unknown;
};

export type PromptFileMode = "inline" | "reference" | "lines";

export type PromptFile = {
  mode?: PromptFileMode;
  mediaType: string;
  data?: string;
  path?: string;
  filename?: string;
  lineRange?: { start: number; end: number };
};

/** Controlled attachment subset: images go to the model, text inlines. */
export const PROMPT_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

export function isInlineTextFile(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") || mediaType === "application/json"
  );
}

export function isSupportedPromptFile(mediaType: string): boolean {
  return (
    PROMPT_IMAGE_MEDIA_TYPES.includes(mediaType) ||
    isInlineTextFile(mediaType)
  );
}

export const MAX_PROMPT_FILES = 8;
export const MAX_PROMPT_FILE_BYTES = 2_000_000;
/** Default threshold (12 KB) beyond which inline attachments degrade to references if path is present */
export const MAX_INLINE_FILE_BYTES = 12_288;

export function estimatedDecodedBytes(base64: string): number {
  return Math.floor(base64.length * 3 / 4);
}

export type PromptInput = {
  text: string;
  files?: PromptFile[];
};

export type PromptMode = "prompt" | "steer" | "followUp";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type RuntimeThinkingInfo = {
  /** The level the runtime will actually use for the current model. */
  level: ThinkingLevel;
  /** Levels accepted by the current model, including `off`. */
  availableLevels: ThinkingLevel[];
  supportsThinking: boolean;
};

export type RuntimeModelRef = {
  providerId: string;
  modelId: string;
};

export type RuntimeModel = RuntimeModelRef & {
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
  available?: boolean;
};

export type RuntimeProvider = {
  id: string;
  displayName?: string;
  authMethods?: Array<"apiKey" | "oauth">;
  authStatus?: "connected" | "missing" | "error";
};

export type PermissionDecision = {
  response: PermissionResponse;
  remember?: boolean;
  /** Whether a remembered decision applies to one request, tool, or conversation. */
  rememberScope?: PermissionRememberScope;
};

export const PERMISSION_REMEMBER_SCOPES = ["request", "tool", "conversation"] as const;
export type PermissionRememberScope = (typeof PERMISSION_REMEMBER_SCOPES)[number];

export const PERMISSION_MODES = ["ask", "read-only", "full-access"] as const;
/** Approval policy for tools that the runtime marks as requiring confirmation. */
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_RESPONSES = ["allow", "deny"] as const;
export type PermissionResponse = (typeof PERMISSION_RESPONSES)[number];

export const ENABLED_RESOURCE_KINDS = ["skill", "extension", "prompt"] as const;
export type EnabledResourceKind = (typeof ENABLED_RESOURCE_KINDS)[number];

export type PermissionRequest = {
  permissionId: string;
  toolName: string;
  toolCallId: string;
  args?: unknown;
  argsSummary?: string;
  risk?: "high" | "standard";
};

export type PermissionPreflightDecision = "allow" | "ask" | "deny";

export type PermissionHandler = {
  request(request: PermissionRequest): Promise<"allow" | "deny">;
  /** Optional policy hook used to suppress prompts for safe, in-workspace reads. */
  preflight?(request: PermissionRequest):
    | PermissionPreflightDecision
    | Promise<PermissionPreflightDecision>;
};

export const TOOLS_REQUIRING_APPROVAL = ["bash", "write", "edit"] as const;

export function asPromptInput(input: string | PromptInput): PromptInput {
  return typeof input === "string" ? { text: input } : input;
}

export type RuntimeExport = {
  jsonl: string;
  html: string;
};

export type CustomToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

export type CustomToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<CustomToolResult>;
};

export type EnabledResource = {
  identity: string;
  version: string;
  source: string;
  kind: EnabledResourceKind;
};

export const PI_BUILTIN_TOOLS = [
  "ls",
  "find",
  "grep",
  "read",
  "edit",
  "write",
  "bash",
] as const;

export type CreateRuntimeSessionOptions = {
  customTools: CustomToolDefinition[];
  builtinTools?: readonly string[];
  systemPrompt?: string;
  enabledResources?: EnabledResource[];
  cwd?: string;
  permissionHandler?: PermissionHandler;
  toolsRequiringApproval?: readonly string[];
  model?: RuntimeModelRef;
  /** Official Pi auto-compaction. Default true when omitted. */
  autoCompact?: boolean;
  inMemory?: boolean;
  workspacePath?: string;
};

export type ForkSessionMode = "new_session" | "branch_in_place";

export type ForkSessionOptions = {
  atEntryId?: string;
  mode?: ForkSessionMode;
};

export type ThebeSessionStats = {
  sessionFile?: string;
  sessionId?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
};

export type ThebeSessionContext = {
  contextUsage: { usedTokens: number; maxTokens: number };
  estimatedCost?: { amount: number; currency: string };
  compaction: {
    lastCompactedAt?: string;
    nearThreshold: boolean;
    enabled?: boolean;
  };
  sessionStats?: ThebeSessionStats;
  sessionName?: string;
};

export type BackgroundTask = {
  id: string;
  name?: string;
  pid?: number;
  port?: number;
  status: "running" | "stopped" | "failed";
  startedAt?: string;
};

export type RuntimeSessionSummary = {
  runtimeSessionId: string;
};

export type OAuthInteraction = {
  type: "oauth";
  openUrl?: (url: string) => Promise<void> | void;
};

export type OAuthDeviceCode = {
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
};

export type OAuthAuthorizeResult =
  | { providerId: string; connected: true; pending?: false }
  | {
      providerId: string;
      connected?: false;
      pending: true;
      url?: string;
      instructions?: string;
      deviceCode?: OAuthDeviceCode;
    };

export type RuntimeAuth = {
  setApiKey(providerId: string, apiKey: string): Promise<void>;
  loginOAuth(
    providerId: string,
    interaction: OAuthInteraction,
  ): Promise<{ kind: "oauth"; providerId: string }>;
  /**
   * Headless OAuth start: kicks off the runtime login in the background and
   * resolves once the provider emits an auth URL / device code (or the login
   * settles). The client shows `url`/`deviceCode` to the user, who completes
   * the flow in a browser; the resulting code comes back via
   * `submitOAuthCallback`. Tokens stay in the runtime, never in AgentStore.
   */
  authorizeOAuth(providerId: string): Promise<OAuthAuthorizeResult>;
  /**
   * Feeds a user-pasted authorization code / redirect URL into a pending
   * `authorizeOAuth` login. Throws when no login is pending for the provider.
   */
  submitOAuthCallback(providerId: string, input: string): Promise<void>;
  logout(providerId: string): Promise<void>;
  check(providerId: string): Promise<{ ok: boolean }>;
  listProviders(): Promise<RuntimeProvider[]>;
  testProvider(providerId: string): Promise<{ ok: boolean; message?: string }>;
};

export interface RuntimeSession {
  runtimeSessionId: string;
  prompt(input: string | PromptInput): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  stopToolCall(toolCallId: string): Promise<void>;
  subscribe(listener: (event: NormalizedEvent) => void): () => void;
  lastAssistantText(): string;
  toolNames(): string[];
  compact(customInstructions?: string): Promise<void>;
  setAutoCompactionEnabled?(enabled: boolean): void;
  autoCompactionEnabled?(): boolean;
  exportSession(): Promise<RuntimeExport>;
  messages(): RuntimeMessage[];
  setModel(model: RuntimeModelRef): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  getThinkingInfo(): RuntimeThinkingInfo;
  getContextUsage(): Promise<ThebeSessionContext>;
  listBackgroundTasks(): Promise<BackgroundTask[]>;
  stopBackgroundTask(taskId: string): Promise<void>;
  revert(): Promise<void>;
  unrevert(): Promise<void>;
  executeBash?(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean },
  ): Promise<{ exitCode?: number; cancelled: boolean; output: string }>;
  getForkMessages?(): Array<{ entryId: string; text: string }>;
  navigateTo?(leafId: string): Promise<void>;
  getLeafId?(): string | undefined;
  /** Reload Pi resources after changing enabled skills or extensions. */
  reloadResources?(): Promise<void>;
  dispose(): void;
}

export interface AgentRuntime {
  readonly runtimeId: string;
  createSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession>;
  resumeSession(
    runtimeSessionId: string,
    options: CreateRuntimeSessionOptions,
  ): Promise<RuntimeSession>;
  listSessions(): Promise<RuntimeSessionSummary[]>;
  /** Permanently removes a runtime session and its persisted transcript. */
  deleteSession(runtimeSessionId: string): Promise<void>;
  forkSession(
    runtimeSessionId: string,
    options: CreateRuntimeSessionOptions,
    fork?: ForkSessionOptions,
  ): Promise<RuntimeSession>;
  listModels(options?: {
    all?: boolean;
    providerId?: string;
  }): Promise<RuntimeModel[]>;
  listAvailableModels(options?: {
    providerId?: string;
  }): Promise<RuntimeModel[]>;
  listProviders(options?: { all?: boolean }): Promise<RuntimeProvider[]>;
  auth(): RuntimeAuth;
  quiesce(): Promise<void>;
  unquiesce(): Promise<void>;
  isQuiesced(): boolean;
  registerSessionLiveness?(
    sessionId: string,
    isActive: () => boolean,
  ): () => void;
  reapInactiveSessions?(): number;
}
