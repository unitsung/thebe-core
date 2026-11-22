import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  FileEntry,
  FilesProvider,
} from "../../agent/capabilities/pipeline.ts";

type Json = Record<string, unknown>;

/** OpenList (AList) file manager as a FilesProvider. */
export class OpenListFilesProvider implements FilesProvider {
  readonly service: string;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    baseUrl: string;
    token: string;
    fetch?: typeof fetch;
    service?: string;
  }) {
    this.base = options.baseUrl.trim().replace(/\/+$/, "");
    this.token = options.token.trim();
    this.fetchImpl = options.fetch ?? fetch;
    this.service = options.service ?? "openlist";
  }

  private async send(
    path: string,
    init: RequestInit,
    timeoutMs = 30_000
  ): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        ...init,
        headers: {
          Authorization: this.token,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (cause) {
      throw new ProviderError("UNREACHABLE", "OpenList is unreachable", cause);
    }
    if (response.status === 401 || response.status === 403)
      throw new ProviderError("UNAUTHORIZED", "OpenList rejected the token");
    if (!response.ok)
      throw new ProviderError(
        "UNKNOWN",
        `OpenList request failed (${response.status})`
      );
    const payload = (await response.json()) as Json;
    if (payload.code !== 200) {
      throw new ProviderError(
        payload.code === 401 || payload.code === 403
          ? "UNAUTHORIZED"
          : "UNKNOWN",
        `OpenList: ${typeof payload.message === "string" ? payload.message.slice(0, 200) : `code ${String(payload.code)}`}`
      );
    }
    return payload;
  }

  private async call(path: string, body: Json): Promise<unknown> {
    return (
      await this.send(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).data;
  }

  async list(input: {
    path: string;
    page?: number;
    perPage?: number;
    refresh?: boolean;
  }) {
    const path = cleanPath(input.path);
    const data = (await this.call("/api/fs/list", {
      path,
      page: input.page ?? 1,
      per_page: Math.min(input.perPage ?? 100, 200),
      refresh: input.refresh ?? false,
    })) as Json | null;
    const content = Array.isArray(data?.content)
      ? (data!.content as unknown[])
      : [];
    const entries: FileEntry[] = content.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const row = raw as Json;
      if (typeof row.name !== "string") return [];
      const hashes = row.hash_info;
      const digest =
        hashes && typeof hashes === "object" && !Array.isArray(hashes)
          ? Object.entries(hashes).find(([algorithm]) =>
              /^sha-?256$/i.test(algorithm)
            )?.[1]
          : undefined;
      return [
        {
          name: row.name,
          path: `${path === "/" ? "" : path}/${row.name}`,
          isDirectory: row.is_dir === true,
          ...(row.is_dir !== true &&
          typeof digest === "string" &&
          /^[a-f0-9]{64}$/i.test(digest)
            ? { sha256: digest.toLowerCase() }
            : {}),
          sizeBytes: typeof row.size === "number" ? row.size : undefined,
          modifiedAt:
            typeof row.modified === "string" ? row.modified : undefined,
        },
      ];
    });
    return {
      entries,
      total: typeof data?.total === "number" ? data.total : entries.length,
    };
  }

  async mkdir(path: string): Promise<void> {
    await this.call("/api/fs/mkdir", { path: cleanPath(path) });
  }

  private async transfer(
    kind: "copy" | "move",
    input: { sourceDir: string; destinationDir: string; names: string[] }
  ) {
    const names = cleanNames(input.names);
    await this.refuseExisting(input.destinationDir, names);
    const data = (await this.call(`/api/fs/${kind}`, {
      src_dir: cleanPath(input.sourceDir),
      dst_dir: cleanPath(input.destinationDir),
      names,
    })) as Json | null;
    return { taskIds: taskIds(data) };
  }

  /**
   * OpenList's own handling of a same-name file in the destination is not documented for the HTTP
   * API, and a move across storages is an upload followed by a delete. So never rely on it: look at the
   * destination first and fail at once, naming what is already there, so neither copy nor move can
   * overwrite or replace anything.
   */
  private async refuseExisting(
    destinationDir: string,
    names: string[]
  ): Promise<void> {
    const wanted = new Set(names);
    const found: string[] = [];
    const perPage = 200;
    for (let page = 1; page <= 25; page += 1) {
      const { entries, total } = await this.list({
        path: destinationDir,
        page,
        perPage,
      });
      for (const entry of entries)
        if (wanted.has(entry.name)) found.push(entry.name);
      if (page * perPage >= total || entries.length === 0) break;
    }
    if (found.length > 0) {
      throw new ProviderError(
        "UNKNOWN",
        `${found.join(", ")} already exist${found.length === 1 ? "s" : ""} in ${cleanPath(destinationDir)}; nothing was copied or moved. Choose another destination or rename it first`
      );
    }
  }

  copy(input: { sourceDir: string; destinationDir: string; names: string[] }) {
    return this.transfer("copy", input);
  }
  move(input: { sourceDir: string; destinationDir: string; names: string[] }) {
    return this.transfer("move", input);
  }

  async rename(input: {
    dir: string;
    name: string;
    newName: string;
  }): Promise<void> {
    const name = cleanName(input.name);
    await this.call("/api/fs/rename", {
      path: joinPath(input.dir, name),
      name: cleanName(input.newName),
      overwrite: false,
    });
  }

  async remove(input: {
    dir: string;
    names: string[];
    recursive?: boolean;
  }): Promise<void> {
    const names = cleanNames(input.names);
    if (input.recursive !== true) {
      for (const name of names) {
        const entry = (await this.call("/api/fs/get", {
          path: joinPath(input.dir, name),
        })) as Json | null;
        if (entry?.is_dir !== true) continue;
        const listing = (await this.call("/api/fs/list", {
          path: joinPath(input.dir, name),
          page: 1,
          per_page: 1,
          refresh: false,
        })) as Json | null;
        if (typeof listing?.total === "number" && listing.total > 0)
          throw new ProviderError(
            "UNKNOWN",
            `${name} is not empty; pass recursive: true to remove it`
          );
      }
    }
    await this.call("/api/fs/remove", {
      dir: cleanPath(input.dir),
      names,
    });
  }

  async upload(input: {
    dir: string;
    name: string;
    sourcePath: string;
  }): Promise<void> {
    const info = await stat(input.sourcePath);
    if (!info.isFile())
      throw new ProviderError(
        "UNKNOWN",
        "Upload source must be a regular file"
      );
    const target = joinPath(input.dir, cleanName(input.name));
    await this.send(
      "/api/fs/put",
      {
        method: "PUT",
        headers: {
          "Content-Length": String(info.size),
          "File-Path": encodePath(target),
          Overwrite: "false",
        },
        body: Readable.toWeb(
          createReadStream(input.sourcePath)
        ) as unknown as NonNullable<RequestInit["body"]>,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
      10 * 60_000
    );
  }

  async offlineDownload(input: {
    urls: string[];
    destinationDir: string;
    tool?: string;
  }) {
    const urls = input.urls.map((url) => url.trim()).filter(Boolean);
    if (urls.length === 0)
      throw new ProviderError("UNKNOWN", "At least one URL is required");
    const data = (await this.call("/api/fs/add_offline_download", {
      urls,
      path: cleanPath(input.destinationDir),
      tool: input.tool?.trim() || "SimpleHttp",
      delete_policy: "delete_on_upload_succeed",
    })) as Json | null;
    return { taskIds: taskIds(data) };
  }
}

function cleanPath(value: string): string {
  const path = `/${value.trim().replace(/^\/+/, "")}`
    .replace(/\/{2,}/g, "/")
    .replace(/(.)\/$/, "$1");
  if (path.split("/").includes(".."))
    throw new ProviderError("UNKNOWN", "Path must not contain ..");
  return path;
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[/\\]/.test(name))
    throw new ProviderError("UNKNOWN", `Invalid name: ${value}`);
  return name;
}

function cleanNames(values: string[]): string[] {
  if (values.length === 0)
    throw new ProviderError("UNKNOWN", "names is required");
  return values.map(cleanName);
}

function joinPath(dir: string, name: string): string {
  const parent = cleanPath(dir);
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function encodePath(path: string): string {
  return cleanPath(path).split("/").map(encodeURIComponent).join("/");
}

function taskIds(data: Json | null): string[] {
  const tasks = data?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((task) =>
    task && typeof task === "object" && typeof (task as Json).id === "string"
      ? [(task as Json).id as string]
      : []
  );
}

export function createOpenListFilesProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): OpenListFilesProvider | undefined {
  const pick = (...values: Array<string | undefined>) =>
    values.map((value) => value?.trim() ?? "").find(Boolean) ?? "";
  const baseUrl = pick(env.THEBE_OPENLIST_BASE_URL, env.OPENLIST_BASE_URL);
  const token = pick(env.THEBE_OPENLIST_TOKEN, env.OPENLIST_TOKEN);
  return baseUrl && token
    ? new OpenListFilesProvider({ baseUrl, token })
    : undefined;
}
