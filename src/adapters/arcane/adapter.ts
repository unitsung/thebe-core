import {
  ProviderError,
  type ContainerDetail,
  type ContainerInfoProvider,
  type ContainerState,
  type ContainerSummary,
  type HostStatusSummary,
} from "../../agent/capabilities/containers.ts";

export type ArcaneLogSocket = AsyncIterable<string>;

export type OpenArcaneLogSocket = (
  url: string,
  headers: Record<string, string>,
) => Promise<ArcaneLogSocket> | ArcaneLogSocket;

export type ArcaneAdapterOptions = {
  baseUrl: string;
  apiKey: string;
  environmentId?: string;
  fetch?: typeof fetch;
  now?: () => number;
  pageSize?: number;
  maxPages?: number;
  openLogSocket?: OpenArcaneLogSocket;
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

const DEFAULT_MAX_PAGES = 1_000;
const MAX_LOG_TAIL = 200;

export class ArcaneAdapter implements ContainerInfoProvider {
  // Checked 2026-09-05 against instance v2.10.2 openapi.json:
  // list uses pagination.totalItems and names[]; inspect state is {status,running};
  // counts has no paused/exited (paused stays 0, exited uses stoppedContainers).
  // Auth header is X-API-Key (X-Api-Key is equivalent).
  // Unverified: WS logs path, frame format, default environmentId "0".
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly environmentId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly openLogSocket: OpenArcaneLogSocket;

  constructor(options: ArcaneAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.environmentId = options.environmentId ?? "0";
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.pageSize = options.pageSize ?? 100;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.maxPages = Number.isFinite(maxPages)
      ? Math.max(1, Math.min(Math.floor(maxPages), DEFAULT_MAX_PAGES))
      : DEFAULT_MAX_PAGES;
    this.openLogSocket = options.openLogSocket ?? defaultOpenLogSocket;
  }

  async listContainers(): Promise<ContainerSummary[]> {
    const all: ContainerSummary[] = [];
    let start = 0;
    for (let page = 0; page < this.maxPages; page += 1) {
      const body = await this.requestJson(
        `/api/environments/${this.environmentId}/containers?limit=${this.pageSize}&start=${start}&order=asc`,
      );
      const rows = asArray(body.data).map(mapSummary);
      all.push(...rows);
      const total =
        numberField(asObject(body.pagination), "totalItems") || all.length;
      start += rows.length;
      if (rows.length === 0 || start >= total || rows.length < this.pageSize) {
        return all;
      }
    }
    throw new ProviderError(
      "UNKNOWN",
      "Arcane container pagination exceeded safety limit",
    );
  }

  async inspectContainer(id: string): Promise<ContainerDetail> {
    const body = await this.requestJson(
      `/api/environments/${this.environmentId}/containers/${encodeURIComponent(id)}`,
    );
    return mapDetail(asObject(body.data));
  }

  async getContainerLogs(id: string, tail?: number): Promise<string> {
    const linesWanted = normalizeLogTail(tail);
    const encodedId = encodeURIComponent(id);
    const path =
      `/api/environments/${this.environmentId}/ws/containers/${encodedId}/logs` +
      `?follow=false&tail=${linesWanted}&timestamps=true&format=json&batched=false`;
    const url = `${httpToWs(this.baseUrl)}${path}`;
    const headers = { "X-Api-Key": this.apiKey };
    let frames: string[];
    try {
      frames = [];
      for await (const frame of await this.openLogSocket(url, headers)) {
        frames.push(...parseLogWsPayload(frame));
        if (frames.length >= linesWanted + 80) {
          break;
        }
      }
    } catch (cause) {
      throw new ProviderError(
        "UNREACHABLE",
        "Arcane log stream is unreachable",
        cause,
      );
    }
    return frames.join("\n");
  }

  async restartContainer(id: string): Promise<void> {
    await this.requestJson(
      `/api/environments/${this.environmentId}/containers/${encodeURIComponent(id)}/restart`,
      { method: "POST" },
    );
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

  private async requestJson(
    path: string,
    init: { method?: string } = {},
  ): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
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
      const parsed = JSON.parse(text) as Json;
      if (parsed.success === false) {
        throw new ProviderError("UNKNOWN", "Arcane API returned an error");
      }
      return parsed;
    } catch (cause) {
      if (cause instanceof ProviderError) {
        throw cause;
      }
      throw new ProviderError("UNKNOWN", "Arcane returned invalid JSON", cause);
    }
  }
}

function httpToWs(baseUrl: string): string {
  if (baseUrl.startsWith("https://")) {
    return `wss://${baseUrl.slice("https://".length)}`;
  }
  if (baseUrl.startsWith("http://")) {
    return `ws://${baseUrl.slice("http://".length)}`;
  }
  return baseUrl;
}

function parseLogWsPayload(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => messageFromLogObject(asObject(item)));
    }
    if (parsed && typeof parsed === "object") {
      return messageFromLogObject(asObject(parsed));
    }
  } catch {
    if (trimmed.includes("\n")) {
      const parts = trimmed
        .split("\n")
        .flatMap((part) => parseLogWsPayload(part));
      if (parts.length > 0) {
        return parts;
      }
    }
    return [trimmed];
  }
  return [trimmed];
}

function messageFromLogObject(obj: Json): string[] {
  for (const key of ["message", "Message", "msg", "log"]) {
    const value = obj[key];
    if (typeof value === "string") {
      return [value];
    }
  }
  return [];
}

async function defaultOpenLogSocket(
  url: string,
  headers: Record<string, string>,
): Promise<ArcaneLogSocket> {
  const frames: string[] = [];
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Arcane log websocket timed out"));
    }, 15_000);
    ws.addEventListener("message", (event) => {
      frames.push(String(event.data));
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Arcane log websocket failed"));
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("open", () => {
      setTimeout(() => ws.close(), 800);
    });
  });
  return (async function* () {
    yield* frames;
  })();
}

function statusToCode(
  status: number,
): ProviderError["code"] {
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
