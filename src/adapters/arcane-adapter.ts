import {
  ProviderError,
  type ContainerDetail,
  type ContainerInfoProvider,
  type ContainerState,
  type ContainerSummary,
  type HostStatusSummary,
} from "../providers/index.ts";

export type ArcaneAdapterOptions = {
  baseUrl: string;
  apiKey: string;
  environmentId?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

type Json = Record<string, unknown>;

const STATES = new Set<ContainerState>([
  "running",
  "exited",
  "paused",
  "dead",
  "created",
  "restarting",
]);

export class ArcaneAdapter implements ContainerInfoProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly environmentId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: ArcaneAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.environmentId = options.environmentId ?? "0";
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  async listContainers(): Promise<ContainerSummary[]> {
    const body = await this.requestJson(
      `/api/environments/${this.environmentId}/containers`,
    );
    const rows = asArray(body.data);
    return rows.map(mapSummary);
  }

  async inspectContainer(id: string): Promise<ContainerDetail> {
    const body = await this.requestJson(
      `/api/environments/${this.environmentId}/containers/${id}`,
    );
    return mapDetail(asObject(body.data));
  }

  async getContainerLogs(id: string, tail?: number): Promise<string> {
    const query = tail === undefined ? "" : `?tail=${tail}`;
    const body = await this.requestJson(
      `/api/environments/${this.environmentId}/containers/${id}/logs${query}`,
    );
    if (typeof body.data === "string") {
      return body.data;
    }
    if (typeof body === "string") {
      return body;
    }
    return String(body.data ?? "");
  }

  async getStatusSummary(): Promise<HostStatusSummary> {
    const body = await this.requestJson(
      `/api/environments/${this.environmentId}/containers/counts`,
    );
    const counts = asObject(body.data);
    const total = numberField(counts, "totalContainers");
    const running = numberField(counts, "runningContainers");
    const paused = numberField(counts, "pausedContainers");
    const exited =
      numberField(counts, "exitedContainers") ||
      numberField(counts, "stoppedContainers");
    return {
      totalContainers: total,
      runningContainers: running,
      pausedContainers: paused,
      exitedContainers: exited,
      lastUpdated: this.now(),
    };
  }

  private async requestJson(path: string): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          Accept: "application/json",
          "X-Api-Key": this.apiKey,
        },
      });
    } catch (cause) {
      throw new ProviderError("UNREACHABLE", "Arcane is unreachable", cause);
    }
    if (!response.ok) {
      throw new ProviderError(
        statusToCode(response.status),
        `Arcane HTTP ${response.status}`,
      );
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as Json;
    } catch {
      return { data: text };
    }
  }
}

function statusToCode(
  status: number,
): ProviderError["code"] {
  if (status === 404) return "NOT_FOUND";
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 429) return "RATE_LIMITED";
  return "UNKNOWN";
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function numberField(obj: Json, key: string): number {
  const value = obj[key];
  return typeof value === "number" ? value : 0;
}

function stripSlash(name: string): string {
  return name.replace(/^\//, "");
}

function mapState(raw: string): ContainerState {
  const lower = raw.toLowerCase();
  if (STATES.has(lower as ContainerState)) {
    return lower as ContainerState;
  }
  return "created";
}

function mapSummary(row: Json): ContainerSummary {
  const name =
    (typeof row.name === "string" && row.name) ||
    (Array.isArray(row.names) && typeof row.names[0] === "string"
      ? row.names[0]
      : row.id);
  return {
    id: String(row.id ?? ""),
    name: stripSlash(String(name ?? "")),
    image: String(row.image ?? ""),
    state: mapState(String(row.state ?? "created")),
    status: String(row.status ?? ""),
    created: typeof row.created === "number" ? row.created : 0,
  };
}

function mapDetail(row: Json): ContainerDetail {
  const state = row.state;
  const stateText =
    typeof state === "string"
      ? state
      : String(asObject(state).status ?? "created");
  const config = asObject(row.config);
  const env = Array.isArray(config.env)
    ? config.env.map((item) => String(item))
    : undefined;
  const cmd = Array.isArray(config.cmd)
    ? config.cmd.map((item) => String(item))
    : undefined;
  const ports = mapPorts(row.ports);
  return {
    id: String(row.id ?? ""),
    name: stripSlash(String(row.name ?? row.id ?? "")),
    image: String(row.image ?? ""),
    state: stateText,
    config: { env, cmd },
    networkSettings: ports ? { ports } : undefined,
  };
}

function mapPorts(
  raw: unknown,
): Record<string, Array<{ HostIp: string; HostPort: string }>> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const ports: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const item of raw) {
    const row = asObject(item);
    const privatePort = row.privatePort ?? row.PrivatePort;
    const publicPort = row.publicPort ?? row.PublicPort;
    const ip = String(row.ip ?? row.IP ?? "0.0.0.0");
    const type = String(row.type ?? row.Type ?? "tcp");
    if (typeof privatePort !== "number" || typeof publicPort !== "number") {
      continue;
    }
    const key = `${privatePort}/${type}`;
    const list = ports[key] ?? [];
    list.push({ HostIp: ip, HostPort: String(publicPort) });
    ports[key] = list;
  }
  return Object.keys(ports).length > 0 ? ports : undefined;
}
