import { describe, expect, it, vi } from "vitest";
import { QBittorrentDownloadProvider } from "./qbittorrent-downloads.ts";
import { OpenListFilesProvider } from "./openlist-files.ts";
import { OpenListTransferProvider } from "./openlist-transfer.ts";
import { MediaServerRefreshProvider } from "./library-refresh.ts";
import {
  availablePipelineTools,
  createPipelineTools,
} from "../../agent/tools/pipeline-tools.ts";
import { PIPELINE_WRITE_TOOL_NAMES } from "../../agent/capabilities/pipeline.ts";
import { downloadItem } from "../../testing/download-item.ts";

const hash = "a".repeat(40);

function qbit() {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    if (url.endsWith("auth/login"))
      return new Response("Ok.", {
        headers: { "set-cookie": "SID=s; Path=/" },
      });
    if (url.includes("torrents/add")) return new Response("Ok.");
    if (url.includes("torrents/info"))
      return Response.json([
        {
          hash,
          name: "Movie",
          state: "stalledUP",
          progress: 1,
          size: 10,
          content_path: "/dl/Movie",
          save_path: "/dl",
          added_on: 100,
          completion_on: 200,
        },
        {
          hash: "b".repeat(40),
          name: "Show",
          state: "downloading",
          progress: 0.4,
          dlspeed: 5,
          eta: 30,
        },
        { hash: "bad" },
      ]);
    return new Response("");
  });
  return {
    calls,
    provider: new QBittorrentDownloadProvider({
      baseUrl: "https://q.example/",
      username: "u",
      password: "p",
      fetch: fetchImpl,
    }),
  };
}

describe("qBittorrent downloads", () => {
  it("adds sources with save path and category and rejects unsafe schemes", async () => {
    const { provider, calls } = qbit();
    expect(
      await provider.add({
        urls: ["magnet:?xt=urn:btih:abc"],
        savePath: "/media/in",
        category: "movies",
        paused: true,
      })
    ).toEqual({ submitted: 1, engine: "qbittorrent" });
    const add = calls.find((call) => call.url.includes("torrents/add"))!;
    expect(add.body).toContain("savepath=%2Fmedia%2Fin");
    expect(add.body).toContain("category=movies");
    await expect(
      provider.add({ urls: ["file:///etc/passwd"] })
    ).rejects.toThrow("Unsupported");
  });

  it("maps list rows into states and drops invalid hashes", async () => {
    const { provider } = qbit();
    const rows = await provider.list({ filter: "all" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      hash,
      state: "seeding",
      progress: 1,
      contentPath: "/dl/Movie",
    });
    expect(rows[1]).toMatchObject({
      state: "downloading",
      progress: 0.4,
      etaSeconds: 30,
    });
    await expect(provider.get("nope")).rejects.toThrow("Invalid torrent hash");
  });
});

describe("qBittorrent pause and resume", () => {
  function qbitControl(version: string, known: string[] = [hash]) {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url.endsWith("auth/login"))
        return new Response("Ok.", {
          headers: { "set-cookie": "SID=s; Path=/" },
        });
      if (url.endsWith("app/version")) return new Response(version);
      if (url.includes("torrents/info"))
        return Response.json(
          known.map((value) => ({
            hash: value,
            name: "T",
            state: "downloading",
            progress: 0.1,
          }))
        );
      return new Response("");
    });
    const provider = new QBittorrentDownloadProvider({
      baseUrl: "https://q.example/",
      username: "u",
      password: "p",
      fetch: fetchImpl,
    });
    const actions = () =>
      calls
        .filter((call) => /torrents\/(stop|start|pause|resume)$/.test(call.url))
        .map((call) => ({
          path: call.url.split("/api/v2/")[1],
          body: call.body,
        }));
    return { provider, calls, actions };
  }

  it("uses stop and start on qBittorrent 5", async () => {
    const { provider, actions } = qbitControl("v5.0.1");
    await provider.pause([hash]);
    await provider.resume([hash.toUpperCase()]);
    expect(actions()).toEqual([
      { path: "torrents/stop", body: `hashes=${hash}` },
      { path: "torrents/start", body: `hashes=${hash}` },
    ]);
  });

  it("uses pause and resume on qBittorrent 4 and reads the version once", async () => {
    const { provider, actions, calls } = qbitControl("v4.6.7");
    await provider.pause([hash]);
    await provider.resume([hash]);
    expect(actions().map((action) => action.path)).toEqual([
      "torrents/pause",
      "torrents/resume",
    ]);
    expect(
      calls.filter((call) => call.url.endsWith("app/version"))
    ).toHaveLength(1);
  });

  it("joins several hashes once, without duplicates", async () => {
    const other = "b".repeat(40);
    const { provider, actions } = qbitControl("v5.0.0", [hash, other]);
    await provider.pause([hash, other, hash]);
    expect(actions()).toEqual([
      { path: "torrents/stop", body: `hashes=${hash}%7C${other}` },
    ]);
  });

  it("rejects unknown, malformed, and oversized requests without sending an action", async () => {
    const { provider, actions } = qbitControl("v5.0.0");
    await expect(provider.pause(["c".repeat(40)])).rejects.toThrow(
      "Unknown torrent: cccccccc"
    );
    await expect(provider.resume([hash, "d".repeat(40)])).rejects.toThrow(
      "Unknown torrent: dddddddd"
    );
    await expect(provider.pause(["nope"])).rejects.toThrow(
      "Invalid torrent hash"
    );
    await expect(provider.pause([])).rejects.toThrow("between 1 and 20");
    await expect(
      provider.pause(
        Array.from({ length: 21 }, (_, index) =>
          index.toString(16).padStart(40, "0")
        )
      )
    ).rejects.toThrow("between 1 and 20");
    expect(actions()).toEqual([]);
  });

  it("exposes the tools only when the provider supports them, and routes to it", async () => {
    const base = { service: "q", add: vi.fn(), list: vi.fn(), get: vi.fn() };
    expect(availablePipelineTools({ downloads: base })).not.toContain(
      "download.pause"
    );
    const pause = vi.fn(async () => {});
    const resume = vi.fn(async () => {});
    const get = vi.fn(async () =>
      downloadItem({
        hash,
        name: "Show",
        state: "downloading",
        progress: 0.4,
        capabilities: ["pause", "resume", "remove", "remove_with_files"],
      })
    );
    const downloads = { ...base, get, pause, resume };
    const names = availablePipelineTools({ downloads });
    expect(names).toEqual(
      expect.arrayContaining(["download.pause", "download.resume"])
    );
    expect(PIPELINE_WRITE_TOOL_NAMES).toEqual(
      expect.arrayContaining(["download.pause", "download.resume"])
    );

    const allow = { allow: () => ({ ok: true }) } as any;
    const tools = createPipelineTools(
      { downloads },
      { policy: allow, callerId: "c" }
    );
    const result = await tools
      .find((tool) => tool.name === "download.pause")!
      .execute("1", { hashes: [hash] });
    expect(pause).toHaveBeenCalledWith([hash]);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      requested: 1,
      hashes: [hash],
    });
    await tools
      .find((tool) => tool.name === "download.resume")!
      .execute("2", { hashes: [hash] });
    expect(resume).toHaveBeenCalledWith([hash]);
    await expect(
      tools
        .find((tool) => tool.name === "download.pause")!
        .execute("3", { hashes: [] })
    ).rejects.toThrow("must not be empty");
    expect(pause).toHaveBeenCalledTimes(1);

    // A control the download does not offer is refused before anything is sent to the engine.
    get.mockResolvedValueOnce(
      downloadItem({
        hash,
        name: "Show",
        state: "paused",
        progress: 0.4,
        capabilities: ["resume", "remove"],
      })
    );
    await expect(
      tools
        .find((tool) => tool.name === "download.pause")!
        .execute("3b", { hashes: [hash] })
    ).rejects.toThrow("does not offer pause while paused");
    get.mockResolvedValueOnce(undefined as never);
    await expect(
      tools
        .find((tool) => tool.name === "download.resume")!
        .execute("3c", { hashes: [hash] })
    ).rejects.toThrow("Unknown download");
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);

    const deny = { allow: () => ({ ok: false, reason: "blocked" }) } as any;
    const blocked = createPipelineTools(
      { downloads },
      { policy: deny, callerId: "c" }
    ).find((tool) => tool.name === "download.resume")!;
    await expect(blocked.execute("4", { hashes: [hash] })).rejects.toThrow(
      "blocked"
    );
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe("qBittorrent delete", () => {
  function qbitDelete(known: string[] = [hash]) {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url.endsWith("auth/login"))
        return new Response("Ok.", {
          headers: { "set-cookie": "SID=s; Path=/" },
        });
      if (url.includes("torrents/info"))
        return Response.json(
          known.map((value) => ({
            hash: value,
            name: "T",
            state: "downloading",
            progress: 0.1,
          }))
        );
      return new Response("");
    });
    const provider = new QBittorrentDownloadProvider({
      baseUrl: "https://q.example/",
      username: "u",
      password: "p",
      fetch: fetchImpl,
    });
    const deletes = () =>
      calls
        .filter((call) => call.url.endsWith("torrents/delete"))
        .map((call) => call.body);
    return { provider, deletes };
  }

  it("sends deleteFiles exactly as stated", async () => {
    const { provider, deletes } = qbitDelete();
    await provider.remove([hash], false);
    await provider.remove([hash], true);
    expect(deletes()).toEqual([
      `hashes=${hash}&deleteFiles=false`,
      `hashes=${hash}&deleteFiles=true`,
    ]);
  });

  it("rejects unknown and malformed hashes without deleting anything", async () => {
    const { provider, deletes } = qbitDelete();
    await expect(provider.remove(["c".repeat(40)], true)).rejects.toThrow(
      "Unknown torrent: cccccccc"
    );
    await expect(provider.remove(["nope"], true)).rejects.toThrow(
      "Invalid torrent hash"
    );
    await expect(provider.remove([], false)).rejects.toThrow(
      "between 1 and 20"
    );
    expect(deletes()).toEqual([]);
  });

  it("is exposed only with provider support, needs an explicit deleteFiles, and is policy-gated", async () => {
    const base = { service: "q", add: vi.fn(), list: vi.fn(), get: vi.fn() };
    expect(availablePipelineTools({ downloads: base })).not.toContain(
      "download.delete"
    );
    const remove = vi.fn(async () => {});
    const get = vi.fn(async () =>
      downloadItem({
        hash,
        name: "Show",
        state: "completed",
        progress: 1,
        capabilities: ["remove"],
      })
    );
    const downloads = { ...base, get, remove };
    expect(availablePipelineTools({ downloads })).toContain("download.delete");
    expect(PIPELINE_WRITE_TOOL_NAMES).toContain("download.delete");

    const allow = { allow: () => ({ ok: true }) } as any;
    const tool = createPipelineTools(
      { downloads },
      { policy: allow, callerId: "c" }
    ).find((item) => item.name === "download.delete")!;
    await expect(tool.execute("1", { hashes: [hash] })).rejects.toThrow(
      "deleteFiles"
    );
    await expect(
      tool.execute("2", { hashes: [hash], deleteFiles: "yes" })
    ).rejects.toThrow("deleteFiles");
    expect(remove).not.toHaveBeenCalled();
    const result = await tool.execute("3", {
      hashes: [hash],
      deleteFiles: false,
    });
    expect(remove).toHaveBeenCalledWith([hash], false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      requested: 1,
      deleteFiles: false,
    });

    // This download can be removed but not together with its files.
    await expect(
      tool.execute("3b", { hashes: [hash], deleteFiles: true })
    ).rejects.toThrow("does not offer remove_with_files");
    expect(remove).toHaveBeenCalledTimes(1);

    const deny = { allow: () => ({ ok: false, reason: "blocked" }) } as any;
    const blocked = createPipelineTools(
      { downloads },
      { policy: deny, callerId: "c" }
    ).find((item) => item.name === "download.delete")!;
    await expect(
      blocked.execute("4", { hashes: [hash], deleteFiles: true })
    ).rejects.toThrow("blocked");
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("OpenList files", () => {
  function openlist(payload: unknown) {
    const calls: Array<{ url: string; body: any; auth: string | null }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ code: 200, data: payload });
    });
    return {
      calls,
      provider: new OpenListFilesProvider({
        baseUrl: "https://ol.example",
        token: "tok",
        fetch: fetchImpl,
      }),
    };
  }

  it("lists directories with joined paths", async () => {
    const { provider, calls } = openlist({
      total: 2,
      content: [
        { name: "a.mkv", is_dir: false, size: 5 },
        { name: "Season 1", is_dir: true },
      ],
    });
    const listing = await provider.list({ path: "media//movies/" });
    expect(calls[0]?.body.path).toBe("/media/movies");
    expect(calls[0]?.auth).toBe("tok");
    expect(listing.entries[1]).toMatchObject({
      path: "/media/movies/Season 1",
      isDirectory: true,
    });
  });

  it("copies named entries and refuses traversal", async () => {
    const { provider, calls } = openlist({ tasks: [{ id: "t1" }] });
    expect(
      await provider.copy({
        sourceDir: "/dl",
        destinationDir: "/lib/Movies",
        names: ["Movie"],
      })
    ).toEqual({ taskIds: ["t1"] });
    expect(calls[0]?.url).toContain("/api/fs/copy");
    expect(calls[0]?.body).toMatchObject({
      src_dir: "/dl",
      dst_dir: "/lib/Movies",
      names: ["Movie"],
    });
    await expect(
      provider.move({
        sourceDir: "/dl",
        destinationDir: "/lib",
        names: ["../x"],
      })
    ).rejects.toThrow("Invalid name");
    await expect(provider.mkdir("/lib/../etc")).rejects.toThrow("..");
  });

  it("surfaces application level errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ code: 500, message: "storage not found" })
    );
    const provider = new OpenListFilesProvider({
      baseUrl: "https://ol.example",
      token: "t",
      fetch: fetchImpl,
    });
    await expect(provider.list({ path: "/x" })).rejects.toThrow(
      "storage not found"
    );
  });
});

describe("OpenList transfer", () => {
  function openlistTransfer(
    handlers: Array<(url: string, init?: RequestInit) => Response | undefined>
  ) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      for (const handler of handlers) {
        const response = handler(url, init);
        if (response) return response;
      }
      return new Response("");
    });
    return {
      calls,
      provider: new OpenListTransferProvider({
        baseUrl: "https://ol.example/",
        token: "tok",
        fetch: fetchImpl,
      }),
    };
  }

  it("submits an offline download into the destination folder", async () => {
    const { provider, calls } = openlistTransfer([
      (url) =>
        url.endsWith("/api/fs/add_offline_download")
          ? Response.json({ code: 200, data: { tasks: [{ id: "task-1" }] } })
          : undefined,
    ]);
    const started = await provider.submit({
      source: "https://pan.example/s/abc",
      destinationDir: "media/Movies",
      tool: "115 Cloud",
    });
    expect(started).toEqual({ handle: "task-1" });
    expect(calls[0]?.url).toContain("/api/fs/add_offline_download");
    expect(calls[0]?.body).toMatchObject({
      urls: ["https://pan.example/s/abc"],
      path: "/media/Movies",
      tool: "115 Cloud",
    });
  });

  it("reports pending with progress, completion with the content name, and failure", async () => {
    let undone: unknown[] = [{ id: "task-1", progress: 40 }];
    let done: unknown[] = [];
    const { provider } = openlistTransfer([
      (url) =>
        url.endsWith("/api/task/offline_download/undone")
          ? Response.json({ code: 200, data: undone })
          : undefined,
      (url) =>
        url.endsWith("/api/task/offline_download/done")
          ? Response.json({ code: 200, data: done })
          : undefined,
    ]);
    expect(await provider.status("task-1")).toEqual({
      state: "pending",
      progress: 0.4,
    });

    undone = [];
    done = [{ id: "task-1", state: 2, name: "Dune.2021" }];
    expect(await provider.status("task-1")).toEqual({
      state: "completed",
      contentName: "Dune.2021",
    });

    done = [{ id: "task-1", state: 7, error: "link expired" }];
    expect(await provider.status("task-1")).toEqual({
      state: "error",
      message: "link expired",
    });

    // Unknown handles stay pending rather than failing the job.
    done = [];
    expect(await provider.status("missing")).toEqual({ state: "pending" });
  });

  it("surfaces application-level errors and rejects an empty source", async () => {
    const failing = openlistTransfer([
      () => Response.json({ code: 500, message: "storage not found" }),
    ]).provider;
    await expect(
      failing.submit({
        source: "https://pan.example/s/abc",
        destinationDir: "/x",
      })
    ).rejects.toThrow("storage not found");
    const ok = openlistTransfer([]).provider;
    await expect(
      ok.submit({ source: "  ", destinationDir: "/x" })
    ).rejects.toThrow("source link");
  });
});

describe("media server refresh", () => {
  it("scans and refreshes one item", async () => {
    const calls: Array<{ url: string; token: string | null }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({
        url: String(input),
        token: new Headers(init?.headers).get("x-emby-token"),
      });
      return new Response(null, { status: 204 });
    });
    const provider = new MediaServerRefreshProvider("emby", {
      baseUrl: "https://emby.example/",
      apiKey: "k",
      fetch: fetchImpl,
    });
    await provider.scan();
    await provider.refreshItem({ id: "123", replaceAllMetadata: true });
    expect(calls[0]).toEqual({
      url: "https://emby.example/Library/Refresh",
      token: "k",
    });
    expect(calls[1]?.url).toContain("/Items/123/Refresh?");
    expect(calls[1]?.url).toContain("ReplaceAllMetadata=true");
    expect(() => provider.refreshItem({ id: "../x" })).toThrow(
      "Invalid item id"
    );
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
    expect(names).toEqual([
      "download.add",
      "download.list",
      "download.status",
      "library.scan",
      "library.refresh_item",
    ]);
    expect(
      names.filter((name) =>
        (PIPELINE_WRITE_TOOL_NAMES as readonly string[]).includes(name)
      )
    ).toContain("download.add");
  });

  it("routes calls to the provider and honours the policy", async () => {
    const add = vi.fn(async () => ({ submitted: 1 }));
    const downloads = { service: "q", add, list: vi.fn(), get: vi.fn() };
    const tools = createPipelineTools(
      { downloads },
      { policy: allow, callerId: "c" }
    );
    const tool = tools.find((candidate) => candidate.name === "download.add")!;
    const result = await tool.execute("1", {
      urls: ["magnet:?xt=1"],
      category: "tv",
    });
    expect(add).toHaveBeenCalledWith({
      urls: ["magnet:?xt=1"],
      savePath: undefined,
      category: "tv",
      paused: false,
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ submitted: 1 });
    await expect(tool.execute("2", { urls: [] })).rejects.toThrow(
      "must not be empty"
    );
    const blocked = createPipelineTools(
      { downloads },
      { policy: deny, callerId: "c" }
    )[0]!;
    await expect(blocked.execute("3", {})).rejects.toThrow("blocked");
  });

  it("passes the named engine to download.add and says which engine took the links", async () => {
    const add = vi.fn(async () => ({ submitted: 1, engine: "aria2" }));
    const tool = createPipelineTools(
      { downloads: { service: "q", add, list: vi.fn(), get: vi.fn() } },
      { policy: allow, callerId: "c" }
    ).find((candidate) => candidate.name === "download.add")!;
    const result = await tool.execute("1", {
      urls: ["https://f.example/a.iso"],
      engine: "aria2",
    });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        urls: ["https://f.example/a.iso"],
        engine: "aria2",
      })
    );
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      submitted: 1,
      engine: "aria2",
    });
  });

  it("lists every engine's downloads and names an engine that did not answer", async () => {
    const item = downloadItem({
      hash,
      name: "Show",
      state: "downloading",
      progress: 0.4,
    });
    const listWithProblems = vi.fn(async () => ({
      downloads: [item],
      unreachable: ["aria2: aria2 is down"],
    }));
    const tool = createPipelineTools(
      {
        downloads: {
          service: "q+aria2",
          add: vi.fn(),
          list: vi.fn(),
          listWithProblems,
          get: vi.fn(),
        },
      },
      { policy: allow, callerId: "c" }
    ).find((candidate) => candidate.name === "download.list")!;
    const result = await tool.execute("1", { engine: "qbittorrent", limit: 5 });
    expect(listWithProblems).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "qbittorrent", limit: 5 })
    );
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      downloads: [item],
      unreachable: ["aria2: aria2 is down"],
    });
  });

  it("needs a provider choice when several media servers exist", async () => {
    const libraries = [
      { service: "emby" as const, scan: vi.fn(), refreshItem: vi.fn() },
      { service: "jellyfin" as const, scan: vi.fn(), refreshItem: vi.fn() },
    ];
    const tool = createPipelineTools(
      { libraries },
      { policy: allow, callerId: "c" }
    ).find((candidate) => candidate.name === "library.scan")!;
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
        {
          title: "Dune 2021 1080p WEB-DL",
          seeders: 5,
          size: 3,
          magnetUrl: "magnet:?xt=urn:btih:" + "a".repeat(40),
          indexer: "A",
        },
        {
          title: "Dune 2021 2160p Remux HDR10",
          seeders: 90,
          downloadUrl: "https://x/dl.torrent",
        },
        { title: "No link", seeders: 999 },
        {
          title: "Dune 2021 1080p WEB-DL",
          seeders: 1,
          magnetUrl: "magnet:?xt=urn:btih:" + "b".repeat(40),
        },
      ]);
    });
    const provider = new ProwlarrSearchProvider({
      baseUrl: "https://p.example/",
      apiKey: "k",
      fetch: fetchImpl,
    });
    const rows = await provider.search({ query: "Dune", type: "movie" });
    expect(rows.map((row) => row.seeders)).toEqual([90, 5]);
    expect(rows[0]?.quality).toBe("2160p Remux HDR");
    expect(parseQuality("Album FLAC")).toBe("FLAC");
    await expect(provider.search({ query: "  " })).rejects.toThrow("query");
  });
});
