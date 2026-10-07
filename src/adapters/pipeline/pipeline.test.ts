import { describe, expect, it, vi } from "vitest";
import { QBittorrentDownloadProvider } from "./qbittorrent-downloads.ts";
import { OpenListFilesProvider } from "./openlist-files.ts";
import { MediaServerRefreshProvider } from "./library-refresh.ts";
import { availablePipelineTools, createPipelineTools } from "../../agent/tools/pipeline-tools.ts";
import { PIPELINE_WRITE_TOOL_NAMES } from "../../agent/capabilities/pipeline.ts";

const hash = "a".repeat(40);

function qbit() {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    if (url.endsWith("auth/login")) return new Response("Ok.", { headers: { "set-cookie": "SID=s; Path=/" } });
    if (url.includes("torrents/add")) return new Response("Ok.");
    if (url.includes("torrents/info")) return Response.json([
      { hash, name: "Movie", state: "stalledUP", progress: 1, size: 10, content_path: "/dl/Movie", save_path: "/dl", added_on: 100, completion_on: 200 },
      { hash: "b".repeat(40), name: "Show", state: "downloading", progress: 0.4, dlspeed: 5, eta: 30 },
      { hash: "bad" },
    ]);
    return new Response("");
  });
  return { calls, provider: new QBittorrentDownloadProvider({ baseUrl: "https://q.example/", username: "u", password: "p", fetch: fetchImpl }) };
}

describe("qBittorrent downloads", () => {
  it("adds sources with save path and category and rejects unsafe schemes", async () => {
    const { provider, calls } = qbit();
    expect(await provider.add({ urls: ["magnet:?xt=urn:btih:abc"], savePath: "/media/in", category: "movies", paused: true })).toEqual({ submitted: 1 });
    const add = calls.find(call => call.url.includes("torrents/add"))!;
    expect(add.body).toContain("savepath=%2Fmedia%2Fin");
    expect(add.body).toContain("category=movies");
    await expect(provider.add({ urls: ["file:///etc/passwd"] })).rejects.toThrow("Unsupported");
  });

  it("maps list rows into states and drops invalid hashes", async () => {
    const { provider } = qbit();
    const rows = await provider.list({ filter: "all" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ hash, state: "seeding", progress: 1, contentPath: "/dl/Movie" });
    expect(rows[1]).toMatchObject({ state: "downloading", progress: 0.4, etaSeconds: 30 });
    await expect(provider.get("nope")).rejects.toThrow("Invalid torrent hash");
  });
});

describe("OpenList files", () => {
  function openlist(payload: unknown) {
    const calls: Array<{ url: string; body: any; auth: string | null }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ code: 200, data: payload });
    });
    return { calls, provider: new OpenListFilesProvider({ baseUrl: "https://ol.example", token: "tok", fetch: fetchImpl }) };
  }

  it("lists directories with joined paths", async () => {
    const { provider, calls } = openlist({ total: 2, content: [{ name: "a.mkv", is_dir: false, size: 5 }, { name: "Season 1", is_dir: true }] });
    const listing = await provider.list({ path: "media//movies/" });
    expect(calls[0]?.body.path).toBe("/media/movies");
    expect(calls[0]?.auth).toBe("tok");
    expect(listing.entries[1]).toMatchObject({ path: "/media/movies/Season 1", isDirectory: true });
  });

  it("copies named entries and refuses traversal", async () => {
    const { provider, calls } = openlist({ tasks: [{ id: "t1" }] });
    expect(await provider.copy({ sourceDir: "/dl", destinationDir: "/lib/Movies", names: ["Movie"] })).toEqual({ taskIds: ["t1"] });
    expect(calls[0]?.url).toContain("/api/fs/copy");
    expect(calls[0]?.body).toMatchObject({ src_dir: "/dl", dst_dir: "/lib/Movies", names: ["Movie"] });
    await expect(provider.move({ sourceDir: "/dl", destinationDir: "/lib", names: ["../x"] })).rejects.toThrow("Invalid name");
    await expect(provider.mkdir("/lib/../etc")).rejects.toThrow("..");
  });

  it("surfaces application level errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ code: 500, message: "storage not found" }));
    const provider = new OpenListFilesProvider({ baseUrl: "https://ol.example", token: "t", fetch: fetchImpl });
    await expect(provider.list({ path: "/x" })).rejects.toThrow("storage not found");
  });
});

describe("media server refresh", () => {
  it("scans and refreshes one item", async () => {
    const calls: Array<{ url: string; token: string | null }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), token: new Headers(init?.headers).get("x-emby-token") });
      return new Response(null, { status: 204 });
    });
    const provider = new MediaServerRefreshProvider("emby", { baseUrl: "https://emby.example/", apiKey: "k", fetch: fetchImpl });
    await provider.scan();
    await provider.refreshItem({ id: "123", replaceAllMetadata: true });
    expect(calls[0]).toEqual({ url: "https://emby.example/Library/Refresh", token: "k" });
    expect(calls[1]?.url).toContain("/Items/123/Refresh?");
    expect(calls[1]?.url).toContain("ReplaceAllMetadata=true");
    expect(() => provider.refreshItem({ id: "../x" })).toThrow("Invalid item id");
  });
});

describe("pipeline tools", () => {
  const allow = { allow: () => ({ ok: true }) } as any;
  const deny = { allow: () => ({ ok: false, reason: "blocked" }) } as any;

  it("exposes only what configured providers back, and write tools are known to the approval list", () => {
    expect(availablePipelineTools({})).toEqual([]);
    const names = availablePipelineTools({
      downloads: { service: "q", add: vi.fn(), list: vi.fn(), get: vi.fn() },
      libraries: [{ service: "emby", scan: vi.fn(), refreshItem: vi.fn() }],
    });
    expect(names).toEqual(["download.add", "download.list", "download.status", "library.scan", "library.refresh_item"]);
    expect(names.filter(name => (PIPELINE_WRITE_TOOL_NAMES as readonly string[]).includes(name))).toContain("download.add");
  });

  it("routes calls to the provider and honours the policy", async () => {
    const add = vi.fn(async () => ({ submitted: 1 }));
    const downloads = { service: "q", add, list: vi.fn(), get: vi.fn() };
    const tools = createPipelineTools({ downloads }, { policy: allow, callerId: "c" });
    const tool = tools.find(candidate => candidate.name === "download.add")!;
    const result = await tool.execute("1", { urls: ["magnet:?xt=1"], category: "tv" });
    expect(add).toHaveBeenCalledWith({ urls: ["magnet:?xt=1"], savePath: undefined, category: "tv", paused: false });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ submitted: 1 });
    await expect(tool.execute("2", { urls: [] })).rejects.toThrow("must not be empty");
    const blocked = createPipelineTools({ downloads }, { policy: deny, callerId: "c" })[0]!;
    await expect(blocked.execute("3", {})).rejects.toThrow("blocked");
  });

  it("needs a provider choice when several media servers exist", async () => {
    const libraries = [
      { service: "emby" as const, scan: vi.fn(), refreshItem: vi.fn() },
      { service: "jellyfin" as const, scan: vi.fn(), refreshItem: vi.fn() },
    ];
    const tool = createPipelineTools({ libraries }, { policy: allow, callerId: "c" }).find(candidate => candidate.name === "library.scan")!;
    await expect(tool.execute("1", {})).rejects.toThrow("provider is required");
    await tool.execute("2", { provider: "jellyfin" });
    expect(libraries[1]!.scan).toHaveBeenCalled();
    expect(libraries[0]!.scan).not.toHaveBeenCalled();
  });
});

import { ProwlarrSearchProvider, parseQuality } from "./prowlarr-search.ts";

describe("Prowlarr search", () => {
  it("ranks by seeders, drops results without a download address and reads quality", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain("categories=2000");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("k");
      return Response.json([
        { title: "Dune 2021 1080p WEB-DL", seeders: 5, size: 3, magnetUrl: "magnet:?xt=urn:btih:" + "a".repeat(40), indexer: "A" },
        { title: "Dune 2021 2160p Remux HDR10", seeders: 90, downloadUrl: "https://x/dl.torrent" },
        { title: "No link", seeders: 999 },
        { title: "Dune 2021 1080p WEB-DL", seeders: 1, magnetUrl: "magnet:?xt=urn:btih:" + "b".repeat(40) },
      ]);
    });
    const provider = new ProwlarrSearchProvider({ baseUrl: "https://p.example/", apiKey: "k", fetch: fetchImpl });
    const rows = await provider.search({ query: "Dune", type: "movie" });
    expect(rows.map(row => row.seeders)).toEqual([90, 5]);
    expect(rows[0]?.quality).toBe("2160p Remux HDR");
    expect(parseQuality("Album FLAC")).toBe("FLAC");
    await expect(provider.search({ query: "  " })).rejects.toThrow("query");
  });
});
