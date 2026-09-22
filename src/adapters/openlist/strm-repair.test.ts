import { describe, expect, it } from "vitest";
import { OpenListStrmRepairProvider } from "./strm-repair.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenListStrmRepairProvider", () => {
  it("finds a later-page candidate, repairs the STRM path, and verifies the target", async () => {
    let strmContent = "/Movies/Dune-old.mkv\n";
    const requests: { method: string; url: string; headers: Headers; body: string }[] = [];

    const provider = new OpenListStrmRepairProvider({
      baseUrl: "https://openlist.test",
      token: "openlist-token",
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === "string" ? init.body : "";
        requests.push({ method, url, headers, body });

        if (method === "POST" && url.endsWith("/api/fs/get")) {
          const payload = JSON.parse(body) as { path?: string };
          const path = payload.path ?? "/";
          const encodedPath = `/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
          return jsonResponse(200, {
            code: 200,
            message: "success",
            data: {
              name: path.split("/").pop() ?? path,
              is_dir: false,
              raw_url: `https://openlist.test/p${encodedPath}?sign=signed`,
            },
          });
        }

        if (method === "GET" && url.endsWith("/p/Movies/Dune.strm?sign=signed")) {
          return new Response(strmContent, { status: 200 });
        }

        if (method === "GET" && url.endsWith("/p/Movies/Dune%20(2016).mkv?sign=signed")) {
          return new Response("media-bytes", { status: 200 });
        }

        if (method === "POST" && url.endsWith("/api/fs/search")) {
          const payload = JSON.parse(body) as { page?: number };
          const page = payload.page ?? 1;
          const content = page === 1
            ? Array.from({ length: 100 }, (_, index) => ({
                parent: "/Other",
                name: `Unrelated-${index}.mkv`,
                is_dir: false,
                size: 128,
              }))
            : [
                {
                  parent: "/Movies",
                  name: "Dune (2016).mkv",
                  is_dir: false,
                  size: 128,
                },
              ];
          return jsonResponse(200, {
            code: 200,
            message: "success",
            data: { content },
          });
        }

        if (method === "PUT" && url.endsWith("/api/fs/put")) {
          strmContent = body;
          return jsonResponse(200, { code: 200, message: "success", data: null });
        }

        return jsonResponse(404, { code: 404, message: "not found" });
      },
    });

    const result = await provider.repair({
      arguments: {
        title: "Dune",
        itemId: "/Movies/Dune.strm",
      },
      resource: {
        kind: "strm",
        provider: "openlist",
      },
    });

    expect(result).toMatchObject({
      status: "repaired",
      target: "/Movies/Dune (2016).mkv",
      verification: {
        sourcePath: "/Movies/Dune.strm",
        targetPath: "/Movies/Dune (2016).mkv",
        targetAccessible: true,
      },
    });
    expect(strmContent).toBe("/Movies/Dune (2016).mkv\n");
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual(
      expect.arrayContaining([
        "POST https://openlist.test/api/fs/get",
        "GET https://openlist.test/p/Movies/Dune.strm?sign=signed",
        "POST https://openlist.test/api/fs/search",
        "GET https://openlist.test/p/Movies/Dune%20(2016).mkv?sign=signed",
        "PUT https://openlist.test/api/fs/put",
      ]),
    );
    const searchRequest = requests.find(({ method, url }) => {
      return method === "POST" && url.endsWith("/api/fs/search");
    });
    expect(searchRequest && JSON.parse(searchRequest.body)).toMatchObject({
      parent: "/",
      keywords: "Dune",
      page: 1,
      per_page: 100,
    });
    const writeRequest = requests.find(({ method, url }) => {
      return method === "PUT" && url.endsWith("/api/fs/put");
    });
    expect(writeRequest?.headers.get("File-Path")).toBe("/Movies/Dune.strm");
    expect(requests.filter(({ method }) => method !== "GET").every(({ headers }) => {
      return headers.get("Authorization") === "openlist-token";
    })).toBe(true);

    const writesAfterRepair = requests.filter(({ method, url }) => {
      return method === "PUT" && url.endsWith("/api/fs/put");
    }).length;
    const unchanged = await provider.repair({
      arguments: {
        title: "Dune",
        itemId: "/Movies/Dune.strm",
      },
      resource: {
        kind: "strm",
        provider: "openlist",
      },
    });

    expect(unchanged).toMatchObject({
      status: "unchanged",
      target: "/Movies/Dune (2016).mkv",
    });
    expect(requests.filter(({ method, url }) => {
      return method === "PUT" && url.endsWith("/api/fs/put");
    })).toHaveLength(writesAfterRepair);
  });

  it("matches Unicode media titles without selecting unrelated candidates", async () => {
    let strmContent = "/Movies/流浪地球.strm\n";

    const provider = new OpenListStrmRepairProvider({
      baseUrl: "https://openlist.test",
      token: "openlist-token",
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : "";

        if (method === "POST" && url.endsWith("/api/fs/get")) {
          const payload = JSON.parse(body) as { path?: string };
          const path = payload.path ?? "/";
          const encodedPath = `/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
          return jsonResponse(200, {
            code: 200,
            message: "success",
            data: {
              name: path.split("/").pop() ?? path,
              is_dir: false,
              raw_url: `https://openlist.test/p${encodedPath}?sign=signed`,
            },
          });
        }

        if (method === "GET" && url.endsWith("/p/Movies/%E6%B5%81%E6%B5%AA%E5%9C%B0%E7%90%83.strm?sign=signed")) {
          return new Response(strmContent, { status: 200 });
        }

        if (method === "GET" && url.endsWith("/p/Movies/%E6%B5%81%E6%B5%AA%E5%9C%B0%E7%90%83%202.mkv?sign=signed")) {
          return new Response("media-bytes", { status: 200 });
        }

        if (method === "GET" && url.endsWith("/p/A/Unrelated.mkv?sign=signed")) {
          return new Response("media-bytes", { status: 200 });
        }

        if (method === "POST" && url.endsWith("/api/fs/search")) {
          return jsonResponse(200, {
            code: 200,
            message: "success",
            data: {
              content: [
                { parent: "/A", name: "Unrelated.mkv", is_dir: false },
                { parent: "/Movies", name: "流浪地球 2.mkv", is_dir: false },
              ],
            },
          });
        }

        if (method === "PUT" && url.endsWith("/api/fs/put")) {
          strmContent = body;
          return jsonResponse(200, { code: 200, message: "success", data: null });
        }

        return jsonResponse(404, { code: 404, message: "not found" });
      },
    });

    const result = await provider.repair({
      arguments: { title: "流浪地球", itemId: "/Movies/流浪地球.strm" },
      resource: { kind: "strm", provider: "openlist" },
    });

    expect(result).toMatchObject({
      status: "repaired",
      target: "/Movies/流浪地球 2.mkv",
    });
    expect(strmContent).toBe("/Movies/流浪地球 2.mkv\n");
  });

  it("does not treat a punctuation-only title as a wildcard", async () => {
    const provider = new OpenListStrmRepairProvider({
      baseUrl: "https://openlist.test",
      token: "openlist-token",
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : "";

        if (method === "POST" && url.endsWith("/api/fs/get")) {
          const payload = JSON.parse(body) as { path?: string };
          const path = payload.path ?? "/";
          return jsonResponse(200, {
            code: 200,
            message: "success",
            data: {
              name: path.split("/").pop() ?? path,
              is_dir: false,
              raw_url: "https://openlist.test/p/file?sign=signed",
            },
          });
        }

        if (method === "GET") return new Response("!!!\n", { status: 200 });

        if (method === "POST" && url.endsWith("/api/fs/search")) {
          return jsonResponse(200, {
            code: 200,
            message: "success",
            data: { content: [{ parent: "/Movies", name: "Dune.mkv", is_dir: false }] },
          });
        }

        return jsonResponse(200, { code: 200, message: "success", data: null });
      },
    });

    await expect(provider.repair({
      arguments: { title: "!!!", itemId: "/Movies/!!!.strm" },
      resource: { kind: "strm", provider: "openlist" },
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
