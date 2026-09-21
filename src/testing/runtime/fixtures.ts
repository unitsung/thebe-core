import type {
  CreateRuntimeSessionOptions,
  CustomToolDefinition,
  RuntimeMessage,
  RuntimeModel,
  RuntimeModelRef,
  RuntimeProvider,
  ThinkingLevel,
  BackgroundTask,
} from "../../agent/runtime/interface.ts";

export type FakeQueuedTurn =
  | { kind: "text"; text: string; thinking?: string }
  | {
      kind: "tools";
      calls: Array<{ name: string; args?: unknown; id?: string }>;
    }
  | { kind: "hang" }
  | { kind: "error"; message: string };

export type FakeSessionState = {
  id: string;
  messages: RuntimeMessage[];
  compacted: boolean;
  compactedAt?: string;
  lastCompactInstructions?: string;
  autoCompact: boolean;
  tools: CustomToolDefinition[];
  builtinTools: string[];
  enabledResources: CreateRuntimeSessionOptions["enabledResources"];
  model: RuntimeModelRef;
  thinkingLevel: ThinkingLevel;
  reverted: RuntimeMessage[] | undefined;
  permissionHandler?: CreateRuntimeSessionOptions["permissionHandler"];
  toolsRequiringApproval: string[];
  // Shared across resumed handles of the same underlying session, like abort
  // on a real runtime session: any handle's abort unblocks a hanging turn.
  abortWaiters: Array<() => void>;
  leafId?: string;
  toolAborts: Map<string, AbortController>;
  probeReply?: string;
  resourceReloads: number;
  backgroundTasks: BackgroundTask[];
};

export const FAKE_RUNTIME_MODELS: RuntimeModel[] = [
  {
    providerId: "fake",
    modelId: "fake-1",
    displayName: "Fake One",
    supportsThinking: true,
    available: true,
  },
  {
    providerId: "fake",
    modelId: "fake-2",
    displayName: "Fake Two",
    supportsThinking: false,
    available: true,
  },
  {
    providerId: "opencode",
    modelId: "muse-spark-1.3-free",
    displayName: "Muse Spark 1.3 Free",
    supportsThinking: true,
    available: true,
  },
  {
    providerId: "deepseek",
    modelId: "deepseek-chat",
    displayName: "DeepSeek Chat",
    supportsThinking: false,
    available: true,
  },
  {
    providerId: "deepseek",
    modelId: "deepseek-reasoner",
    displayName: "DeepSeek Reasoner",
    supportsThinking: true,
    available: true,
  },
  {
    providerId: "google",
    modelId: "gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash",
    supportsThinking: false,
    available: true,
  },
  {
    providerId: "anthropic",
    modelId: "claude-3-5-sonnet",
    displayName: "Claude 3.5 Sonnet",
    supportsThinking: true,
    available: true,
  },
];

export const FAKE_RUNTIME_PROVIDERS: Array<
  Omit<RuntimeProvider, "authStatus">
> = [
  {
    id: "fake",
    displayName: "Fake",
    authMethods: ["apiKey", "oauth"],
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    authMethods: ["apiKey"],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    authMethods: ["apiKey"],
  },
  {
    id: "google",
    displayName: "Google",
    authMethods: ["oauth"],
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    authMethods: ["apiKey"],
  },
  {
    id: "emptyco",
    displayName: "Empty Co",
    authMethods: ["oauth"],
  },
];
