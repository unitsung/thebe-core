import { ProviderError } from "../../agent/capabilities/containers.ts";
import type { FileEntry, FilesProvider } from "../../agent/capabilities/pipeline.ts";

type Json = Record<string, unknown>;

/** Pages of 200 entries read from the destination before giving up on checking it. */
const CLASH_CHECK_MAX_PAGES = 50;

/** OpenList (AList) file manager as a FilesProvider. */
export class OpenListFilesProvider implements FilesProvider {
  readonly service = "openlist";
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    this.base = options.baseUrl.trim().replace(/\/+$/, "");
    this.token = options.token.trim();
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async call(path: string, body: Json): Promise<unknown> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: this.token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) throw new ProviderError("UNAUTHORIZED", "OpenList rejected the token");
    if (!response.ok) throw new ProviderError("UNKNOWN", `OpenList request failed (${response.status})`);
    const payload = (await response.json()) as Json;
    if (payload.code !== 200) {
      throw new ProviderError(payload.code === 401 || payload.code === 403 ? "UNAUTHORIZED" : "UNKNOWN",
        `OpenList: ${typeof payload.message === "string" ? payload.message.slice(0, 200) : `code ${String(payload.code)}`}`);
    }
    return payload.data;
  }

  async list(input: { path: string; page?: number; perPage?: number }) {
    const path = cleanPath(input.path);
    const data = (await this.call("/api/fs/list", { path, page: input.page ?? 1, per_page: Math.min(input.perPage ?? 100, 200), refresh: false })) as Json | null;
    const content = Array.isArray(data?.content) ? (data!.content as unknown[]) : [];
    const entries: FileEntry[] = content.flatMap(raw => {
      if (!raw || typeof raw !== "object") return [];
      const row = raw as Json;
      if (typeof row.name !== "string") return [];
      return [{
        name: row.name,
        path: `${path === "/" ? "" : path}/${row.name}`,
        isDirectory: row.is_dir === true,
        sizeBytes: typeof row.size === "number" ? row.size : undefined,
        modifiedAt: typeof row.modified === "string" ? row.modified : undefined,
      }];
    });
    return { entries, total: typeof data?.total === "number" ? data.total : entries.length };
  }

  async mkdir(path: string): Promise<void> {
    await this.call("/api/fs/mkdir", { path: cleanPath(path) });
  }

  private async transfer(kind: "copy" | "move", input: { sourceDir: string; destinationDir: string; names: string[] }) {
    if (input.names.length === 0) throw new ProviderError("UNKNOWN", "names is required");
    for (const name of input.names) if (name.includes("/") || name === ".." || name === ".") throw new ProviderError("UNKNOWN", `Invalid name: ${name}`);
    await this.refuseNameClash(kind, input);
    const data = (await this.call(`/api/fs/${kind}`, {
      src_dir: cleanPath(input.sourceDir), dst_dir: cleanPath(input.destinationDir), names: input.names,
    })) as Json | null;
    return { taskIds: taskIds(data) };
  }

  /**
   * OpenList's move and copy do not document what happens to a name that already exists, so look first
   * and fail before changing anything. That keeps both ordinary writes: neither can overwrite a file.
   */
  private async refuseNameClash(kind: "copy" | "move", input: { sourceDir: string; destinationDir: string; names: string[] }) {
    const destination = cleanPath(input.destinationDir);
    const existing = new Set<string>();
    for (let page = 1; page <= CLASH_CHECK_MAX_PAGES; page += 1) {
      let listed: { entries: FileEntry[]; total: number };
      try {
        listed = await this.list({ path: destination, page, perPage: 200 });
      } catch (error) {
        // A destination that does not exist yet has nothing to clash with.
        if (error instanceof ProviderError && /not found/i.test(error.message)) return;
        throw error;
      }
      for (const entry of listed.entries) existing.add(entry.name);
      if (page * 200 >= listed.total || listed.entries.length === 0) {
        const clashes = input.names.filter(name => existing.has(name));
        if (clashes.length === 0) return;
        throw new ProviderError("UNKNOWN",
          `Not ${kind === "move" ? "moved" : "copied"}: ${clashes.join(", ")} already exists in ${destination}. Nothing was changed; pick another destination or rename first.`);
      }
    }
    // Too large to check: when unsure, do not risk an overwrite.
    throw new ProviderError("UNKNOWN", `Not ${kind === "move" ? "moved" : "copied"}: ${destination} has too many entries to check for a name clash. Nothing was changed.`);
  }

  copy(input: { sourceDir: string; destinationDir: string; names: string[] }) { return this.transfer("copy", input); }
  move(input: { sourceDir: string; destinationDir: string; names: string[] }) { return this.transfer("move", input); }

  async offlineDownload(input: { urls: string[]; destinationDir: string; tool?: string }) {
    const urls = input.urls.map(url => url.trim()).filter(Boolean);
    if (urls.length === 0) throw new ProviderError("UNKNOWN", "At least one URL is required");
    const data = (await this.call("/api/fs/add_offline_download", {
      urls, path: cleanPath(input.destinationDir), tool: input.tool?.trim() || "SimpleHttp", delete_policy: "delete_on_upload_succeed",
    })) as Json | null;
    return { taskIds: taskIds(data) };
  }
}

function cleanPath(value: string): string {
  const path = `/${value.trim().replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  if (path.split("/").includes("..")) throw new ProviderError("UNKNOWN", "Path must not contain ..");
  return path;
}

function taskIds(data: Json | null): string[] {
  const tasks = data?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap(task => task && typeof task === "object" && typeof (task as Json).id === "string" ? [(task as Json).id as string] : []);
}

export function createOpenListFilesProviderFromEnv(env: Record<string, string | undefined> = process.env): OpenListFilesProvider | undefined {
  const pick = (...values: Array<string | undefined>) => values.map(value => value?.trim() ?? "").find(Boolean) ?? "";
  const baseUrl = pick(env.THEBE_OPENLIST_BASE_URL, env.OPENLIST_BASE_URL);
  const token = pick(env.THEBE_OPENLIST_TOKEN, env.OPENLIST_TOKEN);
  return baseUrl && token ? new OpenListFilesProvider({ baseUrl, token }) : undefined;
}
