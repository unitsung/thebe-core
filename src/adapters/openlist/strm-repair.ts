import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  StrmRepairOutcome,
  StrmRepairProvider,
  StrmRepairRequest,
} from "../../agent/capabilities/strm.ts";

type JsonObject = Record<string, unknown>;

type OpenListFile = {
  name: string;
  isDirectory: boolean;
  rawURL?: string;
  sign?: string;
};

type OpenListSearchResult = {
  parent: string;
  name: string;
  isDirectory: boolean;
};

export type OpenListStrmRepairProviderOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  maxSearchResults?: number;
};

/** Provider-owned OpenList implementation for the Core `strm.repair` boundary. */
export class OpenListStrmRepairProvider implements StrmRepairProvider {
  readonly service = "openlist";

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxSearchResults: number;

  constructor(options: OpenListStrmRepairProviderOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.token = options.token.trim();
    this.fetchImpl = options.fetch ?? fetch;
    this.maxSearchResults = Math.max(1, Math.min(options.maxSearchResults ?? 100, 500));
  }

  async repair(input: StrmRepairRequest): Promise<StrmRepairOutcome> {
    const sourcePath = requestPath(input);
    const title = requestTitle(input) || fileStem(sourcePath);
    const sourceFile = await this.getFile(sourcePath);
    if (sourceFile.isDirectory) {
      throw new ProviderError("UNKNOWN", `STRM source is a directory: ${sourcePath}`);
    }

    const before = await this.readText(sourcePath, sourceFile);
    const candidates = await this.search(title);
    const candidate = chooseCandidate(candidates, title);
    if (!candidate) {
      throw new ProviderError("NOT_FOUND", `No media candidate found for ${title}`);
    }

    const targetPath = joinPath(candidate.parent, candidate.name);
    const targetFile = await this.getFile(targetPath);
    if (targetFile.isDirectory) {
      throw new ProviderError("UNKNOWN", `STRM target is a directory: ${targetPath}`);
    }
    await this.probeFile(targetPath, targetFile);

    const currentTarget = parseStrmTarget(before);
    if (currentTarget === targetPath) {
      return {
        status: "unchanged",
        summary: "STRM path is already valid.",
        target: targetPath,
        verification: {
          sourcePath,
          targetPath,
          targetAccessible: true,
        },
      };
    }

    await this.writeText(sourcePath, `${targetPath}\n`);
    const after = await this.readText(sourcePath, await this.getFile(sourcePath));
    if (parseStrmTarget(after) !== targetPath) {
      throw new ProviderError("UNKNOWN", "STRM path verification failed after write");
    }

    return {
      status: "repaired",
      summary: "STRM path repaired and verified.",
      target: targetPath,
      verification: {
        sourcePath,
        targetPath,
        targetAccessible: true,
      },
    };
  }

  private async getFile(path: string): Promise<OpenListFile> {
    const data = await this.requestJSON("/api/fs/get", {
      method: "POST",
      body: { path, password: "" },
    });
    const object = asObject(data);
    return {
      name: stringField(object, "name") || fileName(path),
      isDirectory: object.is_dir === true,
      rawURL: stringField(object, "raw_url") || undefined,
      sign: stringField(object, "sign") || undefined,
    };
  }

  private async readText(path: string, file: OpenListFile): Promise<string> {
    const response = await this.fetchFile(path, file, "text/plain");
    try {
      return await response.text();
    } catch (cause) {
      throw new ProviderError("UNKNOWN", `Unable to read OpenList file: ${path}`, cause);
    }
  }

  private async probeFile(path: string, file: OpenListFile): Promise<void> {
    const response = await this.fetchFile(path, file, "*/*", { Range: "bytes=0-0" });
    await response.body?.cancel();
  }

  private async fetchFile(
    path: string,
    file: OpenListFile,
    accept: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = fileURL(this.baseUrl, path, file);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: accept, ...extraHeaders },
      });
    } catch (cause) {
      throw new ProviderError("UNREACHABLE", `OpenList file is unreachable: ${path}`, cause);
    }
    if (!response.ok) {
      throw new ProviderError(
        response.status === 401 || response.status === 403 ? "UNAUTHORIZED" : "UNKNOWN",
        `OpenList file request failed (${response.status}): ${path}`,
      );
    }
    return response;
  }

  private async search(keyword: string): Promise<OpenListSearchResult[]> {
    const data = await this.requestJSON("/api/fs/search", {
      method: "POST",
      body: {
        parent: "/",
        keywords: keyword,
        scope: 0,
        page: 1,
        per_page: this.maxSearchResults,
        password: "",
      },
    });
    const rawContent = asObject(data).content;
    const content: unknown[] = Array.isArray(rawContent) ? rawContent : [];
    return content
      .map((item: unknown) => asSearchResult(item))
      .filter((item): item is OpenListSearchResult => item !== undefined);
  }

  private async writeText(path: string, content: string): Promise<void> {
    await this.requestJSON("/api/fs/put", {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(content)),
        "File-Path": encodePathHeader(path),
      },
      rawBody: content,
    });
  }

  private async requestJSON(
    path: string,
    options: {
      method: "POST" | "PUT";
      body?: JsonObject;
      headers?: Record<string, string>;
      rawBody?: string;
    },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: {
          Accept: "application/json",
          Authorization: this.token,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      });
    } catch (cause) {
      throw new ProviderError("UNREACHABLE", "OpenList API is unreachable", cause);
    }

    if (!response.ok) {
      throw new ProviderError(
        response.status === 401 || response.status === 403 ? "UNAUTHORIZED" : "UNKNOWN",
        `OpenList API request failed (${response.status})`,
      );
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (cause) {
      throw new ProviderError("UNKNOWN", "OpenList API returned invalid JSON", cause);
    }
    const object = asObject(envelope);
    const code = typeof object.code === "number" ? object.code : 0;
    if (code !== 200) {
      throw new ProviderError(
        code === 401 || code === 403 ? "UNAUTHORIZED" : "UNKNOWN",
        stringField(object, "message") || `OpenList API error (${code})`,
      );
    }
    return object.data;
  }
}

function requestPath(input: StrmRepairRequest): string {
  const args = asObject(input.arguments);
  const resource = input.resource ?? {};
  const raw =
    stringField(args, "itemId") ||
    stringField(args, "path") ||
    stringField(resource, "path") ||
    stringField(resource, "id");
  const path = normalizePath(raw);
  if (!path.toLowerCase().endsWith(".strm")) {
    throw new ProviderError("UNKNOWN", "strm.repair requires a .strm source path");
  }
  return path;
}

function requestTitle(input: StrmRepairRequest): string {
  const args = asObject(input.arguments);
  return stringField(args, "title").trim();
}

function chooseCandidate(results: OpenListSearchResult[], title: string): OpenListSearchResult | undefined {
  const expected = normalizeName(title);
  return results
    .filter((item) => !item.isDirectory && !item.name.toLowerCase().endsWith(".strm"))
    .sort((left, right) => {
      const leftScore = normalizeName(fileStem(left.name)) === expected ? 1 : 0;
      const rightScore = normalizeName(fileStem(right.name)) === expected ? 1 : 0;
      return rightScore - leftScore || left.name.localeCompare(right.name);
    })
    .find((item) => normalizeName(fileStem(item.name)) === expected);
}

function asSearchResult(value: unknown): OpenListSearchResult | undefined {
  const object = asObject(value);
  const name = stringField(object, "name");
  if (!name) return undefined;
  return {
    parent: normalizePath(stringField(object, "parent") || "/"),
    name,
    isDirectory: object.is_dir === true,
  };
}

function parseStrmTarget(content: string): string | undefined {
  const lines = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || lines[0]?.startsWith("#")) return undefined;
  return lines[0];
}

function fileURL(baseUrl: string, path: string, file: OpenListFile): string {
  const raw = file.rawURL?.trim();
  if (raw) {
    if (/^https?:\/\//i.test(raw)) {
      try {
        const rawURL = new URL(raw);
        const baseURL = new URL(baseUrl);
        if (rawURL.host.toLowerCase() === baseURL.host.toLowerCase()) return raw;
      } catch {
        // Fall back to the signed OpenList path below.
      }
    }
    if (raw.startsWith("/")) return `${baseUrl}${raw}`;
  }
  const encodedPath = encodeOpenListPath(path);
  const sign = file.sign?.trim();
  return `${baseUrl}/p${encodedPath}${sign ? `?sign=${sign}` : ""}`;
}

function encodeOpenListPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  return `/${normalized.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

function encodePathHeader(path: string): string {
  return encodeOpenListPath(path);
}

function joinPath(parent: string, name: string): string {
  const base = normalizePath(parent);
  return normalizePath(base === "/" ? `/${name}` : `${base}/${name}`);
}

function normalizePath(value: string): string {
  let path = value.trim();
  const marker = path.indexOf(":/");
  if (!path.startsWith("/") && marker >= 0) path = path.slice(marker + 1);
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

function fileName(path: string): string {
  return normalizePath(path).split("/").pop() ?? path;
}

function fileStem(value: string): string {
  return value.replace(/\.[^.]+$/, "");
}

function normalizeName(value: string): string {
  return fileStem(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringField(object: JsonObject, key: string): string {
  return typeof object[key] === "string" ? object[key] as string : "";
}
