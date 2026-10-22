import { describe, expect, it, vi } from "vitest";
import type {
  DownloadItem,
  DownloadProvider,
} from "../../agent/capabilities/pipeline.ts";
import { downloadItem } from "../../testing/download-item.ts";
import { createDownloadHub } from "./download-hub.ts";

const hash = "a".repeat(40);
const gid = "0123456789abcdef";

function engine(
  service: string,
  items: DownloadItem[] = [],
  options: { failing?: boolean } = {}
) {
  const calls = {
    add: vi.fn(async (input: { urls: string[] }) => ({
      submitted: input.urls.length,
      engine: service,
    })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  const provider: DownloadProvider = {
    service,
    add: calls.add,
    list: vi.fn(async () => {
      if (options.failing) throw new Error(`${service} is down`);
      return items;
    }),
    get: vi.fn(async (id: string) => items.find((item) => item.id === id)),
    pause: calls.pause,
    resume: calls.resume,
    remove: calls.remove,
  };
  return { provider, calls };
}

const torrent = downloadItem({
  hash,
  name: "Show",
  state: "downloading",
  progress: 0.4,
});
const file = downloadItem({
  hash: gid,
  name: "file.iso",
  state: "downloading",
  progress: 0.1,
  engine: "aria2",
});

describe("download hub", () => {
  it("has nothing to offer without an engine and is the engine itself when there is one", () => {
    expect(createDownloadHub([])).toBeUndefined();
    const only = engine("qbittorrent");
    expect(createDownloadHub([only.provider])).toBeDefined();
  });

  it("sends magnets and .torrent files to the torrent engine and direct links to aria2", async () => {
    const qb = engine("qbittorrent");
    const aria = engine("aria2");
    const hub = createDownloadHub([qb.provider, aria.provider])!;

    const result = await hub.add({
      urls: [
        "magnet:?xt=urn:btih:abc",
        "https://tracker.example/file.torrent?key=1",
        "https://files.example/movie.mkv",
        "ftp://files.example/other.iso",
      ],
      savePath: "/dl",
    });

    expect(qb.calls.add).toHaveBeenCalledWith(
      expect.objectContaining({
        urls: [
          "magnet:?xt=urn:btih:abc",
          "https://tracker.example/file.torrent?key=1",
        ],
        savePath: "/dl",
      })
    );
    expect(aria.calls.add).toHaveBeenCalledWith(
      expect.objectContaining({
        urls: [
          "https://files.example/movie.mkv",
          "ftp://files.example/other.iso",
        ],
      })
    );
    expect(result).toEqual({ submitted: 4, engine: "qbittorrent+aria2" });
  });

  it("sends an address the indexer manager serves to the torrent engine, whatever it looks like", async () => {
    const qb = engine("qbittorrent");
    const aria = engine("aria2");
    const served = "http://prowlarr.lan:9696/anything/at/all?x=1";
    const hub = createDownloadHub([qb.provider, aria.provider], {
      isIndexerAddress: (url) => url.startsWith("http://prowlarr.lan:9696/"),
    })!;

    await hub.add({
      urls: [
        served,
        // Shaped like an indexer address, but not served by it: an ordinary download.
        "https://files.example/download?link=movie.mkv&apikey=1",
      ],
    });

    expect(qb.calls.add).toHaveBeenCalledWith(
      expect.objectContaining({ urls: [served] })
    );
    expect(aria.calls.add).toHaveBeenCalledWith(
      expect.objectContaining({
        urls: ["https://files.example/download?link=movie.mkv&apikey=1"],
      })
    );
  });

  it("sends every link that is not a magnet or .torrent to aria2 when no indexer is known", async () => {
    const qb = engine("qbittorrent");
    const aria = engine("aria2");
    const hub = createDownloadHub([qb.provider, aria.provider])!;
    await hub.add({
      urls: ["http://prowlarr.lan:9696/3/download?apikey=K&link=a"],
    });
    expect(qb.calls.add).not.toHaveBeenCalled();
    expect(aria.calls.add).toHaveBeenCalledOnce();
  });

  it("lets a named engine take the links, and refuses one that is not set up", async () => {
    const qb = engine("qbittorrent");
    const aria = engine("aria2");
    const hub = createDownloadHub([qb.provider, aria.provider])!;

    await hub.add({ urls: ["magnet:?xt=urn:btih:abc"], engine: "aria2" });
    expect(aria.calls.add).toHaveBeenCalledOnce();
    expect(qb.calls.add).not.toHaveBeenCalled();

    const single = createDownloadHub([qb.provider])!;
    await expect(
      single.add({ urls: ["https://x.example/a.iso"], engine: "aria2" })
    ).rejects.toThrow(/aria2 is not configured/);
  });

  it("falls back to the one engine there is, whatever the link", async () => {
    const aria = engine("aria2");
    await createDownloadHub([aria.provider])!.add({
      urls: ["magnet:?xt=urn:btih:abc"],
    });
    expect(aria.calls.add).toHaveBeenCalledOnce();

    const qb = engine("qbittorrent");
    await createDownloadHub([qb.provider])!.add({
      urls: ["https://files.example/movie.mkv"],
    });
    expect(qb.calls.add).toHaveBeenCalledOnce();
  });

  it("lists every engine's downloads, and names an engine that did not answer", async () => {
    const hub = createDownloadHub([
      engine("qbittorrent", [torrent]).provider,
      engine("aria2", [], { failing: true }).provider,
    ])!;

    const all = await hub.listWithProblems!({});
    expect(all.downloads).toEqual([torrent]);
    expect(all.unreachable).toEqual(["aria2: aria2 is down"]);

    const both = createDownloadHub([
      engine("qbittorrent", [torrent]).provider,
      engine("aria2", [file]).provider,
    ])!;
    expect(await both.list({})).toEqual([torrent, file]);
    expect(await both.list({ engine: "aria2" })).toEqual([file]);
  });

  it("keeps a merged list within its limit and gives each engine a share of it", async () => {
    const many = (
      prefix: string,
      count: number,
      engineName: DownloadItem["engine"]
    ) =>
      Array.from({ length: count }, (_, index) =>
        downloadItem({
          hash: prefix.repeat(40).slice(0, 40 - String(index).length) + index,
          name: `${engineName} ${index}`,
          state: "downloading",
          progress: 0.1,
          engine: engineName,
        })
      );
    const hub = createDownloadHub([
      engine("qbittorrent", many("a", 5, "qbittorrent")).provider,
      engine("aria2", many("b", 5, "aria2")).provider,
    ])!;
    const names = (await hub.list({ limit: 4 })).map((item) => item.name);
    expect(names).toEqual([
      "qbittorrent 0",
      "aria2 0",
      "qbittorrent 1",
      "aria2 1",
    ]);
  });

  it("fails when no engine answers", async () => {
    const hub = createDownloadHub([
      engine("qbittorrent", [], { failing: true }).provider,
      engine("aria2", [], { failing: true }).provider,
    ])!;
    await expect(hub.listWithProblems!({})).rejects.toThrow(/is down/);
  });

  it("reads one download from the engine its id belongs to", async () => {
    const qb = engine("qbittorrent", [torrent]);
    const aria = engine("aria2", [file]);
    const hub = createDownloadHub([qb.provider, aria.provider])!;

    expect(await hub.get(gid)).toEqual(file);
    expect(await hub.get(hash)).toEqual(torrent);
    expect(qb.provider.get).toHaveBeenCalledTimes(1);
    expect(aria.provider.get).toHaveBeenCalledTimes(1);
    await expect(hub.get("nope")).rejects.toThrow(/Invalid download id/);
  });

  it("pauses, resumes and removes through the engine each id belongs to", async () => {
    const qb = engine("qbittorrent", [torrent]);
    const aria = engine("aria2", [file]);
    const hub = createDownloadHub([qb.provider, aria.provider])!;

    await hub.pause!([hash, gid]);
    expect(qb.calls.pause).toHaveBeenCalledWith([hash]);
    expect(aria.calls.pause).toHaveBeenCalledWith([gid]);

    await hub.resume!([gid]);
    expect(aria.calls.resume).toHaveBeenCalledWith([gid]);
    expect(qb.calls.resume).not.toHaveBeenCalled();

    await hub.remove!([hash], true);
    expect(qb.calls.remove).toHaveBeenCalledWith([hash], true);
    await expect(hub.pause!(["zz"])).rejects.toThrow(/Invalid download id/);
  });

  it("carries on with the other engine when one fails, and says what was already done", async () => {
    const qb = engine("qbittorrent", [torrent]);
    const aria = engine("aria2", [file]);
    aria.calls.remove.mockRejectedValueOnce(new Error("aria2 is down"));
    const hub = createDownloadHub([qb.provider, aria.provider])!;

    await expect(hub.remove!([hash, gid], false)).rejects.toThrow(
      "aria2: aria2 is down (already done on qbittorrent)"
    );
    expect(qb.calls.remove).toHaveBeenCalledWith([hash], false);

    qb.calls.pause.mockRejectedValueOnce(new Error("qbittorrent is down"));
    aria.calls.pause.mockRejectedValueOnce(new Error("aria2 is down"));
    await expect(hub.pause!([hash, gid])).rejects.toThrow(
      "qbittorrent: qbittorrent is down; aria2: aria2 is down"
    );
  });

  it("offers a control only when an engine has it", () => {
    const bare: DownloadProvider = {
      service: "bare",
      add: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
    };
    const hub = createDownloadHub([bare])!;
    expect(hub.pause).toBeUndefined();
    expect(hub.remove).toBeUndefined();
  });
});
