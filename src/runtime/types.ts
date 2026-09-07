export const PI_RUNTIME_ID = "pi-coding-agent";

export type NormalizedEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; toolName: string; toolCallId: string }
  | { type: "tool_update"; toolName: string; toolCallId: string; text?: string }
  | {
      type: "tool_end";
      toolName: string;
      toolCallId: string;
      isError: boolean;
      text: string;
    }
  | { type: "turn_end" }
  | { type: "session_end"; text: string }
  | { type: "error"; message: string }
  | { type: "compaction_start"; reason?: string }
  | { type: "compaction_end"; aborted?: boolean }
  | { type: "interrupted" }
  | { type: "queue_update"; steering: number; followUp: number }
  | {
      type: "permission_requested";
      permissionId: string;
      toolName: string;
      toolCallId: string;
    };

export type RuntimeMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

export type PromptFile = {
  mediaType: string;
  data: string;
  filename?: string;
};

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

export type RuntimeModelRef = {
  providerID: string;
  modelID: string;
};

export type RuntimeModel = RuntimeModelRef & {
  name?: string;
};

export type RuntimeProvider = {
  id: string;
  name?: string;
  connected?: boolean;
};

export type PermissionDecision = {
  response: "allow" | "deny";
  remember?: boolean;
};

export type PermissionRequest = {
  permissionId: string;
  toolName: string;
  toolCallId: string;
  args?: unknown;
};

export type PermissionHandler = {
  request(request: PermissionRequest): Promise<"allow" | "deny">;
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
  kind: "skill" | "extension" | "prompt";
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
};

export type ForkSessionOptions = {
  atEntryId?: string;
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
   * `submitOAuthCallback`. Tokens stay in the runtime, never in ProductStore.
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
};

export interface RuntimeSession {
  runtimeSessionId: string;
  prompt(input: string | PromptInput): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: NormalizedEvent) => void): () => void;
  lastAssistantText(): string;
  toolNames(): string[];
  compact(): Promise<void>;
  exportSession(): Promise<RuntimeExport>;
  messages(): RuntimeMessage[];
  setModel(model: RuntimeModelRef): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  revert(): Promise<void>;
  unrevert(): Promise<void>;
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
  forkSession(
    runtimeSessionId: string,
    options: CreateRuntimeSessionOptions,
    fork?: ForkSessionOptions,
  ): Promise<RuntimeSession>;
  listModels(options?: { all?: boolean }): Promise<RuntimeModel[]>;
  listAvailableModels(): Promise<RuntimeModel[]>;
  listProviders(options?: { all?: boolean }): Promise<RuntimeProvider[]>;
  auth(): RuntimeAuth;
}
