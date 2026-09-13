export interface ContainerInfoProvider {
  listContainers(): Promise<ContainerSummary[]>;
  inspectContainer(id: string): Promise<ContainerDetail>;
  getContainerLogs(id: string, tail?: number): Promise<string>;
  getStatusSummary(): Promise<HostStatusSummary>;
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

export const CONTAINER_TOOL_DESCRIPTIONS: Record<
  (typeof CONTAINER_TOOL_NAMES)[number],
  string
> = {
  "container.list": "List container summaries in the configured environment",
  "container.inspect": "Inspect one container (env already redacted)",
  "container.logs": "Read recent container logs (redacted and truncated)",
  "container.status_summary": "Host-level container counts",
};
