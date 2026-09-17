export interface ContainerInfoProvider {
  listContainers(): Promise<ContainerSummary[]>;
  inspectContainer(id: string): Promise<ContainerDetail>;
  getContainerLogs(id: string, tail?: number): Promise<string>;
  getStatusSummary(): Promise<HostStatusSummary>;
  /** Write. Product action path only; never attached to the LLM tool loop. */
  restartContainer?(id: string): Promise<void>;
}

export type ProviderErrorCode =
  | "UNREACHABLE"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "UNKNOWN";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
  }
}

export type ContainerState =
  | "running"
  | "exited"
  | "paused"
  | "dead"
  | "created"
  | "restarting";

export type ContainerSummary = {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  status: string;
  created: number;
};

export type ContainerDetail = {
  id: string;
  name: string;
  image: string;
  state: string;
  config: {
    env?: string[];
    cmd?: string[];
    labels?: Record<string, string>;
  };
  networkSettings?: {
    ports?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  };
};

export type HostStatusSummary = {
  totalContainers: number;
  runningContainers: number;
  pausedContainers: number;
  exitedContainers: number;
  lastUpdated: number;
};

export const CONTAINER_TOOL_NAMES = [
  "container.list",
  "container.inspect",
  "container.logs",
  "container.status_summary",
] as const;

export const CONTAINER_RESTART_ACTION_ID = "container.restart" as const;

export type CapabilityEffect = "read" | "write";
export type CapabilityRisk = "low" | "disruptive";
export type CapabilityApproval = "none" | "required";

export type ContainerCapabilityMetadata = {
  effect: CapabilityEffect;
  risk: CapabilityRisk;
  approval: CapabilityApproval;
  permission: "read" | "confirm";
};

/** Source of truth for container capability policy. Not model-authored. */
export const CONTAINER_CAPABILITY_METADATA: Record<
  (typeof CONTAINER_TOOL_NAMES)[number] | typeof CONTAINER_RESTART_ACTION_ID,
  ContainerCapabilityMetadata
> = {
  "container.list": { effect: "read", risk: "low", approval: "none", permission: "read" },
  "container.inspect": { effect: "read", risk: "low", approval: "none", permission: "read" },
  "container.logs": { effect: "read", risk: "low", approval: "none", permission: "read" },
  "container.status_summary": { effect: "read", risk: "low", approval: "none", permission: "read" },
  "container.restart": {
    effect: "write",
    risk: "disruptive",
    approval: "required",
    permission: "confirm",
  },
};

export const CONTAINER_RESTART_METADATA =
  CONTAINER_CAPABILITY_METADATA[CONTAINER_RESTART_ACTION_ID];

/** Shared tool metadata used by the Agent runtime and its MCP view. */
export const CONTAINER_TOOL_SCHEMAS: Record<
  (typeof CONTAINER_TOOL_NAMES)[number],
  Record<string, unknown>
> = {
  "container.list": { type: "object", properties: {} },
  "container.inspect": {
    type: "object",
    properties: { id: { type: "string", description: "Container id" } },
    required: ["id"],
  },
  "container.logs": {
    type: "object",
    properties: {
      id: { type: "string", description: "Container id" },
      tail: { type: "number", description: "Max log lines" },
    },
    required: ["id"],
  },
  "container.status_summary": { type: "object", properties: {} },
};

export const CONTAINER_RESTART_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { id: { type: "string", description: "Container id" } },
  required: ["id"],
};

export const CONTAINER_TOOL_DESCRIPTIONS: Record<
  (typeof CONTAINER_TOOL_NAMES)[number] | typeof CONTAINER_RESTART_ACTION_ID,
  string
> = {
  "container.list": "List container summaries in the configured environment",
  "container.inspect": "Inspect one container (env already redacted)",
  "container.logs": "Read recent container logs (redacted and truncated)",
  "container.status_summary": "Host-level container counts",
  "container.restart":
    "Restart one container. Write, disruptive, requires on-device approval. Not callable by the model.",
};
