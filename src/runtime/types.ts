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
  | { type: "compaction_end"; aborted?: boolean };

export type RuntimeMessage = {
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

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
};

export type RuntimeSessionSummary = {
  runtimeSessionId: string;
};

export type OAuthInteraction = {
  type: "oauth";
  openUrl?: (url: string) => Promise<void> | void;
};

export type RuntimeAuth = {
  setApiKey(providerId: string, apiKey: string): Promise<void>;
  loginOAuth(
    providerId: string,
    interaction: OAuthInteraction,
  ): Promise<{ kind: "oauth"; providerId: string }>;
  logout(providerId: string): Promise<void>;
  check(providerId: string): Promise<{ ok: boolean }>;
};

export interface RuntimeSession {
  runtimeSessionId: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: NormalizedEvent) => void): () => void;
  lastAssistantText(): string;
  toolNames(): string[];
  compact(): Promise<void>;
  exportSession(): Promise<RuntimeExport>;
  messages(): RuntimeMessage[];
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
  ): Promise<RuntimeSession>;
  auth(): RuntimeAuth;
}
