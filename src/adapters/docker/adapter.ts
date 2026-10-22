import {
  ProviderError,
  type ContainerDetail,
  type ContainerInfoProvider,
  type ContainerState,
  type ContainerSummary,
  type HostStatusSummary,
} from "../../agent/capabilities/containers.ts";

/**
 * Docker Engine API container provider, reached through a restricted
 * `docker-socket-proxy` URL. This is the Arcane-free second implementation
 * decided for Core: a client can list/inspect/read logs and restart containers
 * on a host that runs no container panel.
 *
 * Core never opens `docker.sock` directly and only ever talks to the configured
 * proxy root; redirects are refused so a proxy cannot redirect Core elsewhere.
 * Reads are unprivileged on the client side, and the one write
 * (`container.restart`) stays on the product action path with on-device
 * approval, execute, verify, and receipt — it is never attached to the model's
 * tool loop.
 */

export type DockerEngineAdapterOptions = {
  /** Proxy root, e.g. `http://127.0.0.1:2375`. */
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Optional version prefix, e.g. `v1.43`; omitted by default. */
  apiVersion?: string;
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

const MAX_LOG_TAIL = 200;

export class DockerEngineAdapter implements ContainerInfoProvider {
  private readonly baseUrl: string;
  private readonly prefix: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: DockerEngineAdapterOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new Error("Docker proxy URL must start with http:// or https://");
    }
    const version = options.apiVersion?.trim().replace(/^\/+|\/+$/g, "");
    this.prefix = version ? `/${version}` : "";
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  async listContainers(): Promise<ContainerSummary[]> {
    const rows = await this.requestJson(`/containers/json?all=true`);
    if (!Array.isArray(rows)) return [];
    return rows.map(mapSummary);
  }

  async inspectContainer(id: string): Promise<ContainerDetail> {
    const body = await this.requestJson(
      `/containers/${encodeURIComponent(id)}/json`
    );
    return mapDetail(asObject(body));
  }

  async getContainerLogs(id: string, tail?: number): Promise<string> {
    const linesWanted = normalizeLogTail(tail);
    const query = new URLSearchParams({
      stdout: "1",
      stderr: "1",
      tail: String(linesWanted),
      timestamps: "0",
    });
    const response = await this.request(
      "GET",
      `/containers/${encodeURIComponent(id)}/logs?${query.toString()}`
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    return decodeLogFrame(bytes);
  }

  async restartContainer(id: string): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/restart`);
  }

  async getStatusSummary(): Promise<HostStatusSummary> {
    const containers = await this.listContainers();
    let running = 0;
    let paused = 0;
    let exited = 0;
    for (const container of containers) {
      if (container.state === "running") running += 1;
      else if (container.state === "paused") paused += 1;
      else if (container.state === "exited" || container.state === "dead") {
        exited += 1;
      }
    }
    return {
      totalContainers: containers.length,
      runningContainers: running,
      pausedContainers: paused,
      exitedContainers: exited,
      lastUpdated: this.now(),
    };
  }

  private async request(
    method: "GET" | "POST",
    path: string
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${this.prefix}${path}`, {
        method,
        // Never follow a redirect off the configured proxy.
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) {
      if (cause instanceof ProviderError) throw cause;
      throw new ProviderError(
        "UNREACHABLE",
        "Docker proxy is unreachable",
        cause
      );
    }
    if (!response.ok) {
      throw new ProviderError(
        statusToCode(response.status),
        `Docker API HTTP ${response.status}`
      );
    }
    return response;
  }

  private async requestJson(path: string): Promise<unknown> {
    const response = await this.request("GET", path);
    const text = await response.text();
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new ProviderError("UNKNOWN", "Docker returned invalid JSON", cause);
    }
  }
}

/**
 * Docker's non-TTY log stream frames each chunk as
 * `[stream:1][0:3][size:4][payload:size]`. TTY containers (and some proxies)
 * return raw bytes instead, so fall back to UTF-8 text when the framing is not
 * consistent.
 */
function decodeLogFrame(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let offset = 0;
  let framed = true;
  while (offset + 8 <= bytes.length) {
    const stream = bytes[offset]!;
    const size =
      bytes[offset + 4]! * 0x1000000 +
      (bytes[offset + 5]! << 16) +
      (bytes[offset + 6]! << 8) +
      bytes[offset + 7]!;
    if (
      stream > 2 ||
      bytes[offset + 1] !== 0 ||
      bytes[offset + 2] !== 0 ||
      bytes[offset + 3] !== 0 ||
      size > bytes.length - offset - 8
    ) {
      framed = false;
      break;
    }
    const payload = bytes.subarray(offset + 8, offset + 8 + size);
    chunks.push(decoder.decode(payload));
    offset += 8 + size;
  }
  if (!framed || offset !== bytes.length) {
    return decoder.decode(bytes);
  }
  return chunks.join("");
}

function statusToCode(status: number): ProviderError["code"] {
  if (status === 404) return "NOT_FOUND";
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 429) return "RATE_LIMITED";
  return "UNKNOWN";
}

function normalizeLogTail(tail?: number): number {
  const requested =
    typeof tail === "number" && Number.isFinite(tail)
      ? Math.trunc(tail)
      : MAX_LOG_TAIL;
  return Math.min(MAX_LOG_TAIL, Math.max(1, requested));
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function stripSlash(name: string): string {
  return name.replace(/^\//, "");
}

function mapState(raw: string): ContainerState {
  const lower = raw.toLowerCase();
  return STATES.has(lower as ContainerState)
    ? (lower as ContainerState)
    : "created";
}

function mapSummary(value: unknown): ContainerSummary {
  const row = asObject(value);
  const names = Array.isArray(row.Names) ? row.Names : [];
  const name =
    (typeof names[0] === "string" && names[0]) || String(row.Id ?? "");
  return {
    id: String(row.Id ?? ""),
    name: stripSlash(String(name)),
    image: String(row.Image ?? ""),
    state: mapState(String(row.State ?? "created")),
    status: String(row.Status ?? ""),
    created: typeof row.Created === "number" ? row.Created : 0,
  };
}

function mapDetail(row: Json): ContainerDetail {
  const config = asObject(row.Config);
  const state = asObject(row.State);
  const env = Array.isArray(config.Env)
    ? config.Env.map((item) => String(item))
    : undefined;
  const cmd = Array.isArray(config.Cmd)
    ? config.Cmd.map((item) => String(item))
    : undefined;
  const labels =
    config.Labels && typeof config.Labels === "object"
      ? Object.fromEntries(
          Object.entries(config.Labels as Record<string, unknown>).map(
            ([key, value]) => [key, String(value)]
          )
        )
      : undefined;
  const ports = mapPorts(asObject(row.NetworkSettings).Ports);
  return {
    id: String(row.Id ?? ""),
    name: stripSlash(String(row.Name ?? row.Id ?? "")),
    image: String(config.Image ?? ""),
    state: String(state.Status ?? "created"),
    config: { env, cmd, labels },
    networkSettings: ports ? { ports } : undefined,
  };
}

function mapPorts(
  raw: unknown
): Record<string, Array<{ HostIp: string; HostPort: string }>> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const ports: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const [key, bindings] of Object.entries(
    raw as Record<string, unknown>
  )) {
    if (!Array.isArray(bindings)) continue;
    const list = bindings.flatMap((binding) => {
      const row = asObject(binding);
      return [
        {
          HostIp: String(row.HostIp ?? "0.0.0.0"),
          HostPort: String(row.HostPort ?? ""),
        },
      ];
    });
    if (list.length > 0) ports[key] = list;
  }
  return Object.keys(ports).length > 0 ? ports : undefined;
}

/**
 * `THEBE_DOCKER_PROXY_URL` points at a restricted docker-socket-proxy root
 * (e.g. `http://127.0.0.1:2375`). Absent means no Docker provider.
 */
export function createDockerEngineProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): DockerEngineAdapter | undefined {
  const baseUrl =
    env.THEBE_DOCKER_PROXY_URL?.trim() || env.DOCKER_PROXY_URL?.trim() || "";
  if (!baseUrl) return undefined;
  const apiVersion = env.THEBE_DOCKER_API_VERSION?.trim() || undefined;
  return new DockerEngineAdapter({ baseUrl, apiVersion });
}
