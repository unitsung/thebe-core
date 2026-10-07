import { ProviderError } from "../../agent/capabilities/containers.ts";
import type { DownloadItem, DownloadProvider, DownloadState } from "../../agent/capabilities/pipeline.ts";

const HASH = /^[a-f0-9]{40,64}$/i;

/** qBittorrent Web API v2 as a DownloadProvider. Credentials never leave this class. */
export class QBittorrentDownloadProvider implements DownloadProvider {
  readonly service = "qbittorrent";
  private cookie?: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: { baseUrl: string; username: string; password: string; fetch?: typeof fetch }) {
    this.base = options.baseUrl.trim().replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async login(): Promise<void> {
    if (this.cookie) return;
    const response = await this.fetchImpl(`${this.base}/api/v2/auth/login`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Referer: `${this.base}/`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: this.options.username, password: this.options.password }),
    });
    const cookie = response.headers.get("set-cookie")?.match(/(?:^|[,;]\s*)(SID=[^;\s,]+)/)?.[1];
    if (!response.ok || (await response.text()).trim() !== "Ok." || !cookie) {
      throw new ProviderError("UNAUTHORIZED", "qBittorrent login failed");
    }
    this.cookie = cookie;
  }

  private async request(path: string, body?: URLSearchParams, retry = true): Promise<Response> {
    await this.login();
    const response = await this.fetchImpl(`${this.base}/api/v2/${path}`, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Referer: `${this.base}/`, Cookie: this.cookie!, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body,
    });
    if ((response.status === 401 || response.status === 403) && retry) {
      this.cookie = undefined;
      return this.request(path, body, false);
    }
    if (!response.ok) throw new ProviderError("UNKNOWN", `qBittorrent request failed (${response.status})`);
    return response;
  }

  async add(input: { urls: string[]; savePath?: string; category?: string; paused?: boolean }): Promise<{ submitted: number }> {
    const urls = input.urls.map(url => url.trim()).filter(Boolean);
    if (urls.length === 0) throw new ProviderError("UNKNOWN", "At least one URL is required");
    for (const url of urls) {
      if (!/^(magnet:\?|https?:\/\/)/i.test(url)) throw new ProviderError("UNKNOWN", `Unsupported download source: ${url.slice(0, 40)}`);
    }
    const body = new URLSearchParams({ urls: urls.join("\n") });
    if (input.savePath) body.set("savepath", input.savePath);
    if (input.category) body.set("category", input.category);
    if (input.paused) { body.set("paused", "true"); body.set("stopped", "true"); }
    const response = await this.request("torrents/add", body);
    const text = (await response.text()).trim();
    if (text && text !== "Ok.") throw new ProviderError("UNKNOWN", "qBittorrent rejected the download");
    return { submitted: urls.length };
  }

  async list(input: { filter?: string; category?: string; limit?: number }): Promise<DownloadItem[]> {
    const query = new URLSearchParams({ sort: "added_on", reverse: "true", limit: String(Math.min(Math.max(input.limit ?? 30, 1), 100)) });
    const filter = ({ downloading: "downloading", completed: "completed", paused: "paused", errored: "errored" } as Record<string, string>)[input.filter ?? ""];
    if (filter) query.set("filter", filter);
    if (input.category) query.set("category", input.category);
    const data: unknown = await (await this.request(`torrents/info?${query}`)).json();
    if (!Array.isArray(data)) throw new ProviderError("UNKNOWN", "qBittorrent returned invalid torrents");
    return data.flatMap(row => { const item = toItem(row); return item ? [item] : []; });
  }

  async get(hash: string): Promise<DownloadItem | undefined> {
    if (!HASH.test(hash)) throw new ProviderError("UNKNOWN", "Invalid torrent hash");
    const data: unknown = await (await this.request(`torrents/info?hashes=${hash.toLowerCase()}`)).json();
    return Array.isArray(data) ? toItem(data[0]) : undefined;
  }
}

function toState(raw: string, progress: number): DownloadState {
  if (raw === "error" || raw === "missingFiles") return "error";
  if (/^(paused|stopped)/.test(raw)) return progress >= 1 ? "completed" : "paused";
  if (/checking/.test(raw)) return "checking";
  if (/^(queued|allocating|metaDL|forcedMetaDL)/.test(raw)) return "queued";
  if (progress >= 1) return /^(uploading|forcedUP|stalledUP|queuedUP)/.test(raw) ? "seeding" : "completed";
  return "downloading";
}

function toItem(value: unknown): DownloadItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.hash !== "string" || !HASH.test(row.hash)) return undefined;
  const progress = typeof row.progress === "number" ? Math.min(1, Math.max(0, row.progress)) : 0;
  const date = (v: unknown) => typeof v === "number" && v > 0 && v < 8.64e12 ? new Date(v * 1000).toISOString() : undefined;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const text = (v: unknown, max = 500) => typeof v === "string" && v ? v.slice(0, max) : undefined;
  return {
    hash: row.hash.toLowerCase(),
    name: text(row.name) ?? row.hash,
    state: toState(typeof row.state === "string" ? row.state : "", progress),
    progress,
    sizeBytes: num(row.size),
    downloadSpeedBytes: num(row.dlspeed),
    etaSeconds: typeof row.eta === "number" && row.eta >= 0 && row.eta < 8_640_000 ? row.eta : undefined,
    category: text(row.category, 100),
    savePath: text(row.save_path, 1000),
    contentPath: text(row.content_path, 1000),
    addedAt: date(row.added_on),
    completedAt: progress >= 1 ? date(row.completion_on) : undefined,
  };
}

export function createQBittorrentDownloadProviderFromEnv(env: Record<string, string | undefined> = process.env): QBittorrentDownloadProvider | undefined {
  const baseUrl = env.THEBE_QBITTORRENT_URL?.trim();
  const username = env.THEBE_QBITTORRENT_USERNAME?.trim();
  const password = env.THEBE_QBITTORRENT_PASSWORD;
  return baseUrl && username && password ? new QBittorrentDownloadProvider({ baseUrl, username, password }) : undefined;
}
