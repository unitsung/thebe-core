import type { ProductBackgroundTaskProvider, ProviderBackgroundTask } from "../../agent/background-tasks/product.ts";
import { ProviderError } from "../../agent/capabilities/containers.ts";

/** qBittorrent v4/v5 native download tasks. Credentials stay in this adapter. */
export class QBittorrentBackgroundTaskProvider implements ProductBackgroundTaskProvider {
  readonly service = "qbittorrent";
  private cookie?: string;
  private loginPromise?: Promise<void>;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: { baseUrl: string; username: string; password: string; fetch?: typeof fetch }) {
    this.base = options.baseUrl.trim().replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }
  private async login() {
    if (this.cookie) return;
    this.loginPromise ??= (async () => {
      const response = await this.fetchImpl(`${this.base}/api/v2/auth/login`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Referer: `${this.base}/`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: this.options.username, password: this.options.password }),
      });
      const cookie = response.headers.get("set-cookie")?.match(/(?:^|[,;]\s*)(SID=[^;\s,]+)/)?.[1];
      if (!response.ok || (await response.text()).trim() !== "Ok." || !cookie) throw new ProviderError("UNAUTHORIZED", "qBittorrent login failed");
      this.cookie = cookie;
    })().finally(() => { this.loginPromise = undefined; });
    await this.loginPromise;
  }
  private async request(path: string, body?: URLSearchParams, retry = true): Promise<Response> {
    await this.login();
    const response = await this.fetchImpl(`${this.base}/api/v2/${path}`, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Referer: `${this.base}/`, Cookie: this.cookie!, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, body,
    });
    if ((response.status === 401 || response.status === 403) && retry) { this.cookie = undefined; return this.request(path, body, false); }
    if (!response.ok) throw new ProviderError(response.status === 403 ? "UNAUTHORIZED" : "UNKNOWN", `qBittorrent request failed (${response.status})`);
    return response;
  }
  async list(): Promise<ProviderBackgroundTask[]> {
    return this.listPage(0);
  }
  private async listPage(offset: number): Promise<ProviderBackgroundTask[]> {
    const response = await this.request(`torrents/info?sort=added_on&reverse=true&limit=100&offset=${offset}`);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new ProviderError("UNKNOWN", "qBittorrent returned invalid torrents");
    return data.flatMap(value => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      if (typeof row.hash !== "string" || !/^[a-f0-9]{40,64}$/i.test(row.hash)) return [];
      const state = typeof row.state === "string" ? row.state : "unknown";
      const finished = typeof row.progress === "number" && row.progress >= 1;
      const status = state === "error" || state === "missingFiles" ? "failed" : /^(paused|stopped)/.test(state) ? "stopped" : finished && !/checking|moving/.test(state) ? "stopped" : "running";
      const date = (value: unknown) => typeof value === "number" && value > 0 && value < 8.64e12 ? new Date(value * 1000).toISOString() : undefined;
      const startedAt = date(row.added_on);
      const finishedAt = finished ? date(row.completion_on) : undefined;
      const name = typeof row.name === "string" ? row.name.slice(0, 500) : row.hash;
      return [{ id: row.hash, kind: "download", name, status, startedAt, finishedAt, updatedAt: date(row.last_activity) ?? finishedAt ?? startedAt,
        ...(status === "failed" ? { error: state === "missingFiles" ? "Torrent data files are missing" : "qBittorrent reports a torrent error" } : {}),
        ...(finishedAt ? { output: { contentType: "application/json", content: JSON.stringify({ hash: row.hash, name, state, sizeBytes: row.size, completedAt: finishedAt }) } } : {}),
      } satisfies ProviderBackgroundTask];
    });
  }
  async stop(taskId: string): Promise<void> {
    if (!/^[a-f0-9]{40,64}$/i.test(taskId)) throw new ProviderError("UNKNOWN", "Invalid torrent hash");
    const version = (await (await this.request("app/version")).text()).trim();
    const action = Number.parseInt(version.replace(/^v/, ""), 10) >= 5 ? "stop" : "pause";
    await this.request(`torrents/${action}`, new URLSearchParams({ hashes: taskId }));
  }
  async stopAll(): Promise<void> {
    const all: ProviderBackgroundTask[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.listPage(offset);
      all.push(...page);
      if (page.length < 100) break;
      if (offset >= 9900) throw new ProviderError("UNKNOWN", "Too many torrents to stop safely; select individual tasks");
    }
    const tasks = all.filter(task => task.status === "running");
    for (const task of tasks) await this.stop(task.id);
  }
}

export function createQBittorrentBackgroundTaskProviderFromEnv(env = process.env): QBittorrentBackgroundTaskProvider | undefined {
  const baseUrl = env.THEBE_QBITTORRENT_URL?.trim();
  const username = env.THEBE_QBITTORRENT_USERNAME?.trim();
  const password = env.THEBE_QBITTORRENT_PASSWORD;
  return baseUrl && username && password ? new QBittorrentBackgroundTaskProvider({ baseUrl, username, password }) : undefined;
}
