import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WebDavFilesProvider,
  createWebDavFilesProviderFromEnv,
} from "./webdav-files.ts";

type Row = {
  href: string;
  displayName?: string;
  size?: number;
  directory?: boolean;
  modified?: string;
};

function multi(entries: Row[]): string {
  const rows = entries.map(
    (entry) => `<D:response>
<D:href>${entry.href}</D:href>
<D:propstat><D:prop>
${entry.displayName ? `<D:displayname>${entry.displayName}</D:displayname>` : ""}
${entry.size === undefined ? "" : `<D:getcontentlength>${entry.size}</D:getcontentlength>`}
${entry.modified ? `<D:getlastmodified>${entry.modified}</D:getlastmodified>` : ""}
<D:resourcetype>${entry.directory ? "<D:collection/>" : ""}</D:resourcetype>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>`
  );
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${rows.join("\n")}</D:multistatus>`;
}

function xml(body: string): Response {
  return new Response(body, {
    status: 207,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}

describe("WebDAV files", () => {
  it("lists a collection from PROPFIND and strips the base path", async () => {
    const calls: Array<{
      url: string;
      method?: string;
      depth: string | null;
      auth: string | null;
    }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method,
        depth: headers.get("depth"),
        auth: headers.get("authorization"),
      });
      return xml(
        multi([
          { href: "/dav/Movies/", displayName: "Movies", directory: true },
          {
            href: "/dav/Movies/A%20Show/",
            displayName: "A Show",
            directory: true,
            modified: "Wed, 01 Jan 2025 00:00:00 GMT",
          },
          {
            href: "/dav/Movies/clip%20one.mkv",
            displayName: "clip one.mkv",
            size: 7,
          },
        ])
      );
    });
    const provider = new WebDavFilesProvider({
      baseUrl: "https://dav.example/dav/",
      username: "u",
      password: "p",
      fetch: fetchImpl,
    });

    const listing = await provider.list({ path: "/Movies" });
    expect(calls[0]).toMatchObject({
      url: "https://dav.example/dav/Movies",
      method: "PROPFIND",
      depth: "1",
      auth: `Basic ${Buffer.from("u:p").toString("base64")}`,
    });
    expect(listing.total).toBe(2);
    expect(listing.entries).toEqual([
      {
        name: "A Show",
        path: "/Movies/A Show",
        isDirectory: true,
        modifiedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        name: "clip one.mkv",
        path: "/Movies/clip one.mkv",
        isDirectory: false,
        sizeBytes: 7,
      },
    ]);
    expect(listing.entries).toHaveLength(listing.total);
  });

  it("creates collections and renames, copies and moves with Overwrite F", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(input),
        method,
        headers: new Headers(init?.headers),
      });
      if (method === "PROPFIND") return new Response(null, { status: 404 });
      return new Response(null, { status: 201 });
    });
    const provider = new WebDavFilesProvider({
      baseUrl: "https://dav.example/dav",
      token: "tok",
      fetch: fetchImpl,
    });

    await provider.mkdir("/Movies/New");
    expect(calls[0]).toMatchObject({
      url: "https://dav.example/dav/Movies/New",
      method: "MKCOL",
    });

    calls.length = 0;
    await provider.rename({
      dir: "/Movies",
      name: "clip.mkv",
      newName: "clip 2.mkv",
    });
    expect(calls.map((call) => call.method)).toEqual(["PROPFIND", "MOVE"]);
    expect(calls[1]!.url).toBe("https://dav.example/dav/Movies/clip.mkv");
    expect(calls[1]!.headers.get("destination")).toBe(
      "https://dav.example/dav/Movies/clip%202.mkv"
    );
    expect(calls[1]!.headers.get("overwrite")).toBe("F");

    calls.length = 0;
    await provider.copy({
      sourceDir: "/dl",
      destinationDir: "/lib",
      names: ["Movie"],
    });
    expect(calls.map((call) => call.method)).toEqual(["PROPFIND", "COPY"]);
    expect(calls[1]!.headers.get("destination")).toBe(
      "https://dav.example/dav/lib/Movie"
    );
    expect(calls[1]!.headers.get("depth")).toBe("infinity");

    calls.length = 0;
    await provider.move({
      sourceDir: "/dl",
      destinationDir: "/lib",
      names: ["Movie"],
    });
    expect(calls.map((call) => call.method)).toEqual(["PROPFIND", "MOVE"]);
    expect(calls[1]!.headers.get("depth")).toBeNull();
  });

  it("refuses to overwrite and surfaces auth and server errors", async () => {
    const existing = new WebDavFilesProvider({
      baseUrl: "https://dav.example/dav",
      token: "tok",
      fetch: vi.fn<typeof fetch>(async () =>
        xml(multi([{ href: "/dav/lib/Movie", directory: true }]))
      ),
    });
    await expect(
      existing.copy({
        sourceDir: "/dl",
        destinationDir: "/lib",
        names: ["Movie"],
      })
    ).rejects.toThrow("already exists");

    const unauthorized = new WebDavFilesProvider({
      baseUrl: "https://dav.example/dav",
      token: "tok",
      fetch: vi.fn<typeof fetch>(
        async () => new Response("denied", { status: 401 })
      ),
    });
    await expect(unauthorized.list({ path: "/" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    const missing = new WebDavFilesProvider({
      baseUrl: "https://dav.example/dav",
      token: "tok",
      fetch: vi.fn<typeof fetch>(async () => new Response("", { status: 404 })),
    });
    await expect(missing.list({ path: "/x" })).rejects.toThrow("Not found");

    const unreachable = new WebDavFilesProvider({
      baseUrl: "https://dav.example/dav",
      token: "tok",
      fetch: vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(unreachable.list({ path: "/" })).rejects.toMatchObject({
      code: "UNREACHABLE",
    });
  });

  it("deletes a non-empty collection only when recursive is true", async () => {
    const calls: Array<{
      url: string;
      method: string;
      depth: string | null;
    }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const depth = new Headers(init?.headers).get("depth");
      calls.push({ url, method, depth });
      const path = url.slice("https://dav.example".length);
      const isFolder = url.endsWith("Show");
      if (method === "PROPFIND") {
        if (depth === "0")
          return xml(
            multi([
              {
                href: `${path}/`,
                displayName: "Show",
                directory: isFolder,
              },
            ])
          );
        return xml(
          multi([
            { href: `${path}/`, displayName: "Show", directory: true },
            { href: `${path}/ep.mkv`, displayName: "ep.mkv", size: 1 },
          ])
        );
      }
      return new Response(null, { status: 204 });
    });
    const provider = new WebDavFilesProvider({
      baseUrl: "https://dav.example/dav",
      token: "tok",
      fetch: fetchImpl,
    });

    await expect(
      provider.remove({ dir: "/lib", names: ["Show"], recursive: false })
    ).rejects.toThrow("Show is not empty");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    calls.length = 0;
    await provider.remove({ dir: "/lib", names: ["Show"], recursive: true });
    expect(
      calls.filter((call) => call.method === "DELETE").map((call) => call.url)
    ).toEqual(["https://dav.example/dav/lib/Show"]);

    calls.length = 0;
    await provider.remove({
      dir: "/lib",
      names: ["file.mkv"],
      recursive: false,
    });
    expect(calls.map((call) => call.method)).toEqual(["PROPFIND", "DELETE"]);
  });

  it("streams a local file with PUT and refuses an existing target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-webdav-upload-"));
    try {
      const source = join(dir, "clip.mkv");
      await writeFile(source, "video");
      const calls: Array<{ url: string; method: string; headers: Headers }> =
        [];
      let body = "";
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const method = init?.method ?? "GET";
        calls.push({
          url: String(input),
          method,
          headers: new Headers(init?.headers),
        });
        if (method === "PROPFIND") return new Response(null, { status: 404 });
        body = await new Response(
          init!.body as ReadableStream<Uint8Array>
        ).text();
        return new Response(null, { status: 201 });
      });
      const provider = new WebDavFilesProvider({
        baseUrl: "https://dav.example/dav",
        token: "tok",
        fetch: fetchImpl,
      });
      await provider.upload({
        dir: "/lib",
        name: "clip.mkv",
        sourcePath: source,
      });
      const put = calls[1]!;
      expect(put.method).toBe("PUT");
      expect(put.url).toBe("https://dav.example/dav/lib/clip.mkv");
      expect(put.headers.get("content-length")).toBe("5");
      expect(put.headers.get("overwrite")).toBe("F");
      expect(body).toBe("video");

      const taken = new WebDavFilesProvider({
        baseUrl: "https://dav.example/dav",
        token: "tok",
        fetch: vi.fn<typeof fetch>(async () =>
          xml(multi([{ href: "/dav/lib/clip.mkv", size: 1 }]))
        ),
      });
      await expect(
        taken.upload({ dir: "/lib", name: "clip.mkv", sourcePath: source })
      ).rejects.toThrow("already exists");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds from the environment and validates the URL", () => {
    expect(createWebDavFilesProviderFromEnv({})).toBeUndefined();
    expect(() =>
      createWebDavFilesProviderFromEnv({ THEBE_WEBDAV_URL: "not a url" })
    ).toThrow("not a valid URL");
    expect(() =>
      createWebDavFilesProviderFromEnv({ THEBE_WEBDAV_URL: "ftp://x" })
    ).toThrow("http or https");
    expect(
      createWebDavFilesProviderFromEnv({
        THEBE_WEBDAV_URL: "https://dav.example/dav",
        WEBDAV_USERNAME: "u",
        WEBDAV_PASSWORD: "p",
      })?.service
    ).toBe("webdav");
  });
});
