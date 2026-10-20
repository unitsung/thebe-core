import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  DownloadItem,
  DownloadProvider,
  DownloadState,
} from "../../agent/capabilities/pipeline.ts";
import { describeDirect } from "./download-phase.ts";

const GID = /^[a-f0-9]{16}$/i;
const LINK = /^(magnet:\?|https?:\/\/|ftps?:\/\/|sftp:\/\/)/i;
const KEYS = [
  "gid",
  "status",
  "totalLength",
  "completedLength",
  "downloadSpeed",
  "errorMessage",
  "dir",
  "files",
  "bittorrent",
];
const STOPPED = new Set(["complete", "error", "removed"]);

type Row = Record<string, unknown>;

/** aria2 over JSON-RPC as a DownloadProvider. The RPC secret never leaves this class. */
export class Aria2DownloadProvider implements DownloadProvider {
  readonly service = "aria2";
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: {
      baseUrl: string;
      secret?: string;
      fetch?: typeof fetch;
    }
  ) {
    const base = options.baseUrl
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/jsonrpc$/i, "");
    this.endpoint = `${base}/jsonrpc`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async rpc(method: string, params: unknown[] = []): Promise<unknown> {
    const secret = this.options.secret;
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "thebe",
        method,
        params: [...(secret ? [`token:${secret}`] : []), ...params],
      }),
    });
    const payload = (await response.json().catch(() => undefined)) as
      | { result?: unknown; error?: { message?: unknown } }
      | undefined;
    if (payload?.error) {
      const message = String(payload.error.message ?? "request failed");
      throw new ProviderError(
        /unauthorized/i.test(message) ? "UNAUTHORIZED" : "UNKNOWN",
        `aria2: ${message.slice(0, 200)}`
      );
    }
    if (!response.ok || !payload)
      throw new ProviderError(
        "UNKNOWN",
        `aria2 request failed (${response.status})`
      );
    return payload.result;
  }

  private async rows(method: string, params: unknown[]): Promise<Row[]> {
    const result = await this.rpc(method, params);
    return Array.isArray(result)
      ? result.filter((row): row is Row => !!row && typeof row === "object")
      : [];
  }

  async add(input: {
    urls: string[];
    savePath?: string;
    category?: string;
    paused?: boolean;
  }): Promise<{ submitted: number; engine: string }> {
    const urls = input.urls.map((url) => url.trim()).filter(Boolean);
    if (urls.length === 0)
      throw new ProviderError("UNKNOWN", "At least one URL is required");
    for (const url of urls) {
      if (!LINK.test(url))
        throw new ProviderError(
          "UNKNOWN",
          `Unsupported download source: ${url.slice(0, 40)}`
        );
    }
    const options: Record<string, string> = {};
    if (input.savePath) options.dir = input.savePath;
    if (input.paused) options.pause = "true";
    // Several URIs in one call are mirrors of one file, so each link is its own download.
    for (const url of urls) await this.rpc("aria2.addUri", [[url], options]);
    return { submitted: urls.length, engine: this.service };
  }

  /** aria2 reports an unknown gid as an error, so check first rather than report a false success. */
  private async knownGids(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.map((id) => id.trim().toLowerCase()))];
    if (unique.length === 0 || unique.length > 20)
      throw new ProviderError("UNKNOWN", "Provide between 1 and 20 aria2 ids");
    if (unique.some((id) => !GID.test(id)))
      throw new ProviderError("UNKNOWN", "Invalid aria2 id");
    const statuses = new Map<string, string>();
    for (const gid of unique) {
      const row = await this.status(gid, ["gid", "status"]);
      if (!row)
        throw new ProviderError(
          "UNKNOWN",
          `Unknown download: ${gid.slice(0, 8)}`
        );
      statuses.set(gid, String(row.status));
    }
    return statuses;
  }

  private async status(gid: string, keys: string[]): Promise<Row | undefined> {
    try {
      const result = await this.rpc("aria2.tellStatus", [gid, keys]);
      return result && typeof result === "object" ? (result as Row) : undefined;
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message))
        return undefined;
      throw error;
    }
  }

  async pause(ids: string[]): Promise<void> {
    for (const gid of await this.knownGids(ids).then((map) => map.keys()))
      await this.rpc("aria2.pause", [gid]);
  }

  async resume(ids: string[]): Promise<void> {
    for (const gid of await this.knownGids(ids).then((map) => map.keys()))
      await this.rpc("aria2.unpause", [gid]);
  }

  /**
   * aria2's RPC cannot delete files. Removing an unfinished task is what makes the owner's `on-download-stop`
   * script clean its files up, so `deleteFiles` only chooses whether that is asked for: a finished task has no
   * such script run, and its files cannot be deleted through aria2 at all.
   */
  async remove(ids: string[], deleteFiles: boolean): Promise<void> {
    const known = await this.knownGids(ids);
    if (deleteFiles) {
      const finished = [...known].filter(([, status]) => STOPPED.has(status));
      if (finished.length > 0)
        throw new ProviderError(
          "UNKNOWN",
          "aria2 cannot delete the files of a finished download; remove only the task (deleteFiles: false)"
        );
    }
    for (const [gid, status] of known) {
      if (!STOPPED.has(status)) await this.rpc("aria2.forceRemove", [gid]);
      // A running download becomes "removed" in the stopped list; forget that record as well.
      await this.rpc("aria2.removeDownloadResult", [gid]).catch(() => {});
    }
  }

  async list(input: {
    filter?: string;
    category?: string;
    limit?: number;
  }): Promise<DownloadItem[]> {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const [active, waiting, stopped] = await Promise.all([
      this.rows("aria2.tellActive", [KEYS]),
      this.rows("aria2.tellWaiting", [0, 100, KEYS]),
      // A negative offset counts from the most recently stopped, and lists them newest first.
      this.rows("aria2.tellStopped", [-1, limit, KEYS]),
    ]);
    const wanted = (
      {
        downloading: "downloading",
        completed: "completed",
        paused: "paused",
        errored: "error",
      } as Record<string, string>
    )[input.filter ?? ""];
    return [...active, ...waiting, ...stopped]
      .flatMap((row) => {
        const item = toItem(row);
        return item && (!wanted || item.phase === wanted) ? [item] : [];
      })
      .slice(0, limit);
  }

  async get(id: string): Promise<DownloadItem | undefined> {
    if (!GID.test(id.trim()))
      throw new ProviderError("UNKNOWN", "Invalid aria2 id");
    const row = await this.status(id.trim().toLowerCase(), KEYS);
    return row ? toItem(row) : undefined;
  }
}

const number = (value: unknown) => {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const text = (value: unknown, max = 500) =>
  typeof value === "string" && value ? value.slice(0, max) : undefined;

function legacyState(status: string): DownloadState {
  switch (status) {
    case "active":
      return "downloading";
    case "paused":
      return "paused";
    case "error":
      return "error";
    case "complete":
    case "removed":
      return "completed";
    default:
      return "queued";
  }
}

function toItem(row: Row): DownloadItem | undefined {
  if (typeof row.gid !== "string" || !GID.test(row.gid)) return undefined;
  const status = typeof row.status === "string" ? row.status : "";
  const total = number(row.totalLength) ?? 0;
  const done = number(row.completedLength) ?? 0;
  const speed = number(row.downloadSpeed);
  const progress =
    total > 0 ? Math.min(1, done / total) : status === "complete" ? 1 : 0;
  const files = Array.isArray(row.files) ? (row.files as Row[]) : [];
  const firstPath = text(files[0]?.path, 1000);
  const torrentName = text(
    ((row.bittorrent as Row | undefined)?.info as Row | undefined)?.name,
    500
  );
  const dir = text(row.dir, 1000);
  return {
    hash: row.gid.toLowerCase(),
    id: row.gid.toLowerCase(),
    engine: "aria2",
    ...describeDirect(status),
    name: torrentName ?? firstPath?.split("/").filter(Boolean).pop() ?? row.gid,
    state: legacyState(status),
    progress,
    sizeBytes: total > 0 ? total : undefined,
    downloadSpeedBytes: speed,
    etaSeconds:
      status === "active" && speed && speed > 0 && total > done
        ? Math.ceil((total - done) / speed)
        : undefined,
    savePath: dir,
    contentPath: torrentName && dir ? `${dir}/${torrentName}` : firstPath,
    message: status === "error" ? text(row.errorMessage, 300) : undefined,
  };
}

export function createAria2DownloadProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): Aria2DownloadProvider | undefined {
  const baseUrl = env.THEBE_ARIA2_URL?.trim();
  return baseUrl
    ? new Aria2DownloadProvider({
        baseUrl,
        secret: env.THEBE_ARIA2_SECRET?.trim() || undefined,
      })
    : undefined;
}
