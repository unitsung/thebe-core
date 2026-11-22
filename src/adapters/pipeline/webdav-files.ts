import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  FileEntry,
  FilesProvider,
} from "../../agent/capabilities/pipeline.ts";

type ParsedEntry = FileEntry;

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`;

/** A FilesProvider over a WebDAV collection, using Basic/Bearer auth. */
export class WebDavFilesProvider implements FilesProvider {
  readonly service: string;
  private readonly base: string;
  private readonly auth?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    baseUrl: string;
    username?: string;
    password?: string;
    token?: string;
    fetch?: typeof fetch;
    service?: string;
  }) {
    this.base = options.baseUrl.trim().replace(/\/+$/, "");
    this.service = options.service ?? "webdav";
    this.fetchImpl = options.fetch ?? fetch;
    const token = options.token?.trim();
    const username = options.username?.trim();
    if (token) this.auth = `Bearer ${token}`;
    else if (username)
      this.auth = `Basic ${Buffer.from(`${username}:${options.password ?? ""}`).toString("base64")}`;
  }

  async list(input: {
    path: string;
    page?: number;
    perPage?: number;
    refresh?: boolean;
  }) {
    const path = normalizePath(input.path);
    const response = await this.request(path, {
      method: "PROPFIND",
      headers: {
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: PROPFIND_BODY,
    });
    if (response.status === 404)
      throw new ProviderError("UNKNOWN", `Not found: ${path}`);
    await this.requireOK(response, "list", path);
    const entries = parseMultiStatus(await response.text(), this.base)
      .filter((entry) => entry.path !== path)
      .sort((left, right) => left.name.localeCompare(right.name));
    const page = Math.max(1, input.page ?? 1);
    const perPage = Math.min(input.perPage ?? 100, 200);
    return {
      entries: entries.slice((page - 1) * perPage, page * perPage),
      total: entries.length,
    };
  }

  async mkdir(path: string): Promise<void> {
    const target = normalizePath(path);
    const response = await this.request(target, { method: "MKCOL" });
    if (response.status === 405)
      throw new ProviderError("UNKNOWN", `${target} already exists`);
    await this.requireOK(response, "mkdir", target);
  }

  copy(input: { sourceDir: string; destinationDir: string; names: string[] }) {
    return this.transfer("COPY", input);
  }

  move(input: { sourceDir: string; destinationDir: string; names: string[] }) {
    return this.transfer("MOVE", input);
  }

  async rename(input: {
    dir: string;
    name: string;
    newName: string;
  }): Promise<void> {
    const dir = normalizePath(input.dir);
    const source = joinPath(dir, cleanName(input.name));
    const destination = joinPath(dir, cleanName(input.newName));
    await this.refuseExisting(destination);
    const response = await this.request(source, {
      method: "MOVE",
      headers: { Destination: this.url(destination), Overwrite: "F" },
    });
    await this.requireOK(response, "rename", source);
  }

  async remove(input: {
    dir: string;
    names: string[];
    recursive?: boolean;
  }): Promise<void> {
    const dir = normalizePath(input.dir);
    for (const name of cleanNames(input.names)) {
      const target = joinPath(dir, name);
      if (input.recursive !== true) await this.refuseNonEmpty(target, name);
      const response = await this.request(target, { method: "DELETE" });
      await this.requireOK(response, "remove", target);
    }
  }

  async upload(input: {
    dir: string;
    name: string;
    sourcePath: string;
  }): Promise<void> {
    const info = await stat(input.sourcePath).catch(() => undefined);
    if (!info?.isFile())
      throw new ProviderError(
        "UNKNOWN",
        "Upload source must be a regular file"
      );
    const target = joinPath(normalizePath(input.dir), cleanName(input.name));
    await this.refuseExisting(target);
    const response = await this.request(
      target,
      {
        method: "PUT",
        headers: {
          "Content-Length": String(info.size),
          "Content-Type": "application/octet-stream",
          Overwrite: "F",
        },
        body: Readable.toWeb(
          createReadStream(input.sourcePath)
        ) as unknown as NonNullable<RequestInit["body"]>,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
      10 * 60_000
    );
    await this.requireOK(response, "upload", target);
  }

  private async transfer(
    method: "COPY" | "MOVE",
    input: { sourceDir: string; destinationDir: string; names: string[] }
  ): Promise<{ taskIds?: string[] }> {
    const sourceDir = normalizePath(input.sourceDir);
    const destinationDir = normalizePath(input.destinationDir);
    for (const name of cleanNames(input.names)) {
      const source = joinPath(sourceDir, name);
      const destination = joinPath(destinationDir, name);
      await this.refuseExisting(destination);
      const response = await this.request(source, {
        method,
        headers: {
          Destination: this.url(destination),
          ...(method === "COPY" ? { Depth: "infinity" } : {}),
          Overwrite: "F",
        },
      });
      await this.requireOK(
        response,
        method === "COPY" ? "copy" : "move",
        source
      );
    }
    return {};
  }

  private async refuseNonEmpty(path: string, name: string): Promise<void> {
    const entry = await this.statPath(path);
    if (!entry) throw new ProviderError("UNKNOWN", `Not found: ${path}`);
    if (!entry.isDirectory) return;
    const response = await this.request(path, {
      method: "PROPFIND",
      headers: {
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: PROPFIND_BODY,
    });
    await this.requireOK(response, "list", path);
    const children = parseMultiStatus(await response.text(), this.base).filter(
      (child) => child.path !== path
    );
    if (children.length > 0)
      throw new ProviderError(
        "UNKNOWN",
        `${name} is not empty; pass recursive: true to remove it`
      );
  }

  private async statPath(path: string): Promise<ParsedEntry | undefined> {
    const response = await this.request(path, {
      method: "PROPFIND",
      headers: {
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: PROPFIND_BODY,
    });
    if (response.status === 404) return undefined;
    await this.requireOK(response, "stat", path);
    return parseMultiStatus(await response.text(), this.base)[0];
  }

  private async refuseExisting(path: string): Promise<void> {
    if (await this.statPath(path))
      throw new ProviderError(
        "UNKNOWN",
        `${path} already exists; nothing was changed. Choose another name first`
      );
  }

  private url(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === "/") return `${this.base}/`;
    return `${this.base}${normalized
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs = 30_000
  ): Promise<Response> {
    try {
      return await this.fetchImpl(this.url(path), {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        ...init,
        headers: {
          ...(this.auth ? { Authorization: this.auth } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (cause) {
      throw new ProviderError(
        "UNREACHABLE",
        "WebDAV server is unreachable",
        cause
      );
    }
  }

  private async requireOK(
    response: Response,
    action: string,
    path: string
  ): Promise<void> {
    if (response.ok) return;
    const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
    throw new ProviderError(
      response.status === 401 || response.status === 403
        ? "UNAUTHORIZED"
        : "UNKNOWN",
      `WebDAV ${action} failed for ${path} (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }
}

function parseMultiStatus(xml: string, base: string): ParsedEntry[] {
  const basePath = new URL(`${base}/`).pathname.replace(/\/+$/, "");
  const entries: ParsedEntry[] = [];
  for (const match of xml.matchAll(
    /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi
  )) {
    const block = match[1] ?? "";
    const href = tagValue(block, "href");
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, `${base}/`);
    } catch {
      continue;
    }
    // Hrefs may be absolute with the server's internal scheme or host behind a
    // proxy; only the path matters, and every request still goes to the base.
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      path = url.pathname;
    }
    if (basePath && (path === basePath || path.startsWith(`${basePath}/`)))
      path = path.slice(basePath.length) || "/";
    if (!path.startsWith("/")) continue;
    path = normalizePath(path);
    const name = tagValue(block, "displayname") || path.split("/").pop() || "/";
    const size = Number(tagValue(block, "getcontentlength"));
    const modified = tagValue(block, "getlastmodified");
    const date = modified ? new Date(modified) : undefined;
    entries.push({
      path,
      name,
      isDirectory: /<(?:[\w.-]+:)?collection\b/i.test(block),
      ...(Number.isFinite(size) && size >= 0 ? { sizeBytes: size } : {}),
      ...(date && !Number.isNaN(date.getTime())
        ? { modifiedAt: date.toISOString() }
        : {}),
    });
  }
  return entries;
}

function tagValue(xml: string, name: string): string | undefined {
  const match = new RegExp(
    `<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`,
    "i"
  ).exec(xml);
  if (!match) return undefined;
  return decodeXml(match[1]!.replace(/<[^>]*>/g, "")).trim() || undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number(decimal))
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizePath(value: string): string {
  const path = `/${value.trim().replace(/^\/+/, "")}`
    .replace(/\/{2,}/g, "/")
    .replace(/(.)\/$/, "$1");
  if (path.split("/").includes(".."))
    throw new ProviderError("UNKNOWN", "Path must not contain ..");
  return path || "/";
}

function joinPath(dir: string, name: string): string {
  const parent = normalizePath(dir);
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
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

export function createWebDavFilesProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): WebDavFilesProvider | undefined {
  const pick = (...values: Array<string | undefined>) =>
    values.map((value) => value?.trim() ?? "").find(Boolean) ?? "";
  const baseUrl = pick(env.THEBE_WEBDAV_URL, env.WEBDAV_URL);
  if (!baseUrl) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`THEBE_WEBDAV_URL is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("THEBE_WEBDAV_URL must use http or https");
  return new WebDavFilesProvider({
    baseUrl,
    username: pick(env.THEBE_WEBDAV_USERNAME, env.WEBDAV_USERNAME) || undefined,
    password: pick(env.THEBE_WEBDAV_PASSWORD, env.WEBDAV_PASSWORD) || undefined,
    token: pick(env.THEBE_WEBDAV_TOKEN, env.WEBDAV_TOKEN) || undefined,
  });
}
