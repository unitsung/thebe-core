import { describe, expect, it, vi } from "vitest";
import { createMusicSourcesFromEnv } from "./index.ts";
import { createNeteaseProvider } from "./netease.ts";
import { createSqMusicProvider } from "./sqmusic.ts";
import {
  parseNeteaseQuery,
  parseSqMusicDownload,
  parseSqMusicQuery,
} from "../../agent/tools/music-sources-tools.ts";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
describe("NetEase provider", () => {
  it("trims a song search to the fields a model needs", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        code: 200,
        result: {
          songs: [
            {
              id: 1,
              name: "晴天",
              ar: [{ name: "周杰伦" }],
              al: { name: "叶惠美" },
              dt: 269000,
              privilege: { huge: "x" },
            },
          ],
        },
      })
    );
    const result = (await createNeteaseProvider(
      "http://nas:13001/",
      request
    ).read({ action: "search", query: "晴天", limit: 5 })) as any;
    expect(result.items).toEqual([
      {
        id: "1",
        name: "晴天",
        artist: "周杰伦",
        album: "叶惠美",
        tracks: undefined,
        durationMs: 269000,
      },
    ]);
    const url = new URL(String(request.mock.calls[0]![0]));
    expect(url.pathname).toBe("/cloudsearch");
    expect(url.searchParams.get("type")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("5");
  });
  it("rejects an API error code and a failed HTTP status", async () => {
    await expect(
      createNeteaseProvider(
        "http://nas",
        vi.fn<typeof fetch>().mockResolvedValue(json({ code: 400 }))
      ).read({ action: "toplist" })
    ).rejects.toThrow("code 400");
    await expect(
      createNeteaseProvider(
        "http://nas",
        vi.fn<typeof fetch>().mockResolvedValue(json({}, 502))
      ).read({ action: "toplist" })
    ).rejects.toThrow("HTTP 502");
  });
});
describe("SQMusic provider", () => {
  const options = { baseUrl: "http://nas:28096", username: "u", password: "p" };
  it("logs in, sends the token header and re-logs in once when it is refused", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ code: 200, data: { tokenValue: "t1" } }))
      .mockResolvedValueOnce(json({ code: 401, msg: "未登录" }))
      .mockResolvedValueOnce(json({ code: 200, data: { tokenValue: "t2" } }))
      .mockResolvedValueOnce(
        json({
          code: 200,
          data: {
            searchTotal: 1,
            records: [
              {
                id: 9,
                name: "晴天",
                artistName: ["周杰伦"],
                albumName: "叶惠美",
                duration: "269000",
                brTypes: ["NETEASE_FLAC_3000"],
                plugName: "netease",
              },
            ],
          },
        })
      );
    const result = (await createSqMusicProvider(options, request).read({
      action: "search",
      plugin: "netease",
      query: "晴天",
    })) as any;
    expect(result.songs).toEqual([
      {
        id: "9",
        name: "晴天",
        artists: ["周杰伦"],
        album: "叶惠美",
        durationMs: 269000,
        qualities: ["NETEASE_FLAC_3000"],
      },
    ]);
    expect(
      (request.mock.calls[3]![1]!.headers as Record<string, string>).sqmusic
    ).toBe("t2");
  });
  it("gives up after one retry and reports the server message", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).includes("login")
          ? json({ code: 200, data: { tokenValue: "t" } })
          : json({ code: 500, msg: "boom" })
      );
    await expect(
      createSqMusicProvider(options, request).read({ action: "tasks" })
    ).rejects.toThrow("SQMusic: boom");
  });
});
describe("SQMusic download", () => {
  const options = { baseUrl: "http://nas:28096", username: "u", password: "p" };
  const record = {
    id: 9,
    name: "晴天",
    plugName: "kw",
    artistName: ["周杰伦"],
    brTypes: ["KW_FLAC", "KW_MP3_128"],
  };
  const route = (calls: { path: string; body?: any }[], tasks: unknown[]) =>
    vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (path.endsWith("/login"))
        return json({ code: 200, data: { tokenValue: "t" } });
      if (path.endsWith("/searchSong"))
        return json({ code: 200, data: { records: [record] } });
      if (path.endsWith("/task/list"))
        return json({ code: 200, data: { records: tasks } });
      return json({ code: 200, data: {} });
    });
  it("sends back SQMusic's own record with the chosen quality and reads the task back", async () => {
    const calls: { path: string; body?: any }[] = [];
    const request = route(calls, [
      {
        id: 3,
        downloadMusicname: "晴天",
        downloadPlugName: "kw",
        downloadStatus: "waiting",
      },
    ]);
    const result = (await createSqMusicProvider(options, request).download({
      plugin: "kw",
      id: "9",
      query: "晴天",
      quality: "KW_MP3_128",
    })) as any;
    const sent = calls.find((call) =>
      call.path.endsWith("/downloadSong")
    )!.body;
    expect(sent).toMatchObject({ id: 9, plugName: "kw", brType: "KW_MP3_128" });
    expect(result).toMatchObject({
      queued: true,
      verified: true,
      task: { id: 3, status: "waiting" },
    });
  });
  it("refuses a song that was not searched and a quality that is not offered, without queuing", async () => {
    const calls: { path: string; body?: any }[] = [];
    const provider = createSqMusicProvider(options, route(calls, []));
    await expect(
      provider.download({ plugin: "kw", id: "404", query: "晴天" })
    ).rejects.toThrow("not in the first results");
    await expect(
      provider.download({
        plugin: "kw",
        id: "9",
        query: "晴天",
        quality: "TIDAL_HI",
      })
    ).rejects.toThrow("not offered");
    expect(calls.some((call) => call.path.endsWith("/downloadSong"))).toBe(
      false
    );
  });
  it("says so when SQMusic accepts the request but the task is not listed", async () => {
    const result = (await createSqMusicProvider(
      options,
      route([], [])
    ).download({ plugin: "kw", id: "9", query: "晴天" })) as any;
    expect(result).toMatchObject({ queued: true, verified: false });
  });
  it("validates the download arguments", () => {
    expect(
      parseSqMusicDownload({ plugin: "kw", id: "9", query: "晴天" })
    ).toEqual({ plugin: "kw", id: "9", query: "晴天" });
    expect(() => parseSqMusicDownload({ plugin: "kw", id: "9" })).toThrow(
      "query"
    );
  });
});
describe("SQMusic album", () => {
  const options = { baseUrl: "http://nas:28096", username: "u", password: "p" };
  const album = {
    albumid: "A1",
    albumName: "叶惠美",
    plugName: "kw",
    artistName: "周杰伦",
    total: 11,
    dataInfo: { musiccnt: 11 },
  };
  const route = (
    calls: { path: string; body?: any }[],
    options: { records?: unknown[]; tasks?: unknown[]; queued?: unknown } = {}
  ) =>
    vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (path.endsWith("/login"))
        return json({ code: 200, data: { tokenValue: "t" } });
      if (path.endsWith("/searchAlbum"))
        return json({
          code: 200,
          data: { records: options.records ?? [album] },
        });
      if (path.endsWith("/downloadAlbum"))
        return json({
          code: 200,
          data: options.queued ?? Array.from({ length: 11 }, () => ({})),
        });
      if (path.endsWith("/task/list"))
        return json({ code: 200, data: { records: options.tasks ?? [] } });
      return json({ code: 200, data: {} });
    });

  it("searches albums and says how many songs each holds", async () => {
    const calls: { path: string; body?: any }[] = [];
    const result = (await createSqMusicProvider(options, route(calls)).read({
      action: "search",
      kind: "album",
      plugin: "kw",
      query: "叶惠美",
    })) as any;
    expect(result.albums).toEqual([
      { id: "A1", name: "叶惠美", artists: ["周杰伦"], songCount: 11 },
    ]);
    expect(calls.some((call) => call.path.endsWith("/searchAlbum"))).toBe(true);
  });

  it("sends back SQMusic's own album record and reads the album's tasks back", async () => {
    const calls: { path: string; body?: any }[] = [];
    const request = route(calls, {
      tasks: [
        {
          id: 1,
          downloadAlbumname: "叶惠美",
          downloadPlugName: "kw",
          downloadStatus: "waiting",
        },
        {
          id: 2,
          downloadAlbumname: "叶惠美",
          downloadPlugName: "kw",
          downloadStatus: "loading",
        },
        {
          id: 3,
          downloadAlbumname: "别的专辑",
          downloadPlugName: "kw",
          downloadStatus: "waiting",
        },
      ],
    });
    const result = (await createSqMusicProvider(options, request).download({
      kind: "album",
      plugin: "kw",
      id: "A1",
      query: "叶惠美",
    })) as any;
    expect(
      calls.find((call) => call.path.endsWith("/downloadAlbum"))!.body
    ).toMatchObject({ albumid: "A1", plugName: "kw" });
    expect(result).toMatchObject({
      queued: true,
      album: "叶惠美",
      songs: 11,
      verified: true,
      tasksSeen: 2,
    });
  });

  it("refuses an album that was not searched, one with too many songs, and a quality, without queuing", async () => {
    const calls: { path: string; body?: any }[] = [];
    const provider = createSqMusicProvider(options, route(calls));
    await expect(
      provider.download({
        kind: "album",
        plugin: "kw",
        id: "nope",
        query: "叶惠美",
      })
    ).rejects.toThrow("not in the first results");
    await expect(
      provider.download({
        kind: "album",
        plugin: "kw",
        id: "A1",
        query: "叶惠美",
        quality: "KW_FLAC",
      })
    ).rejects.toThrow("default quality");
    const big = createSqMusicProvider(
      options,
      route(calls, {
        records: [{ ...album, total: 120, dataInfo: { musiccnt: 120 } }],
      })
    );
    await expect(
      big.download({ kind: "album", plugin: "kw", id: "A1", query: "叶惠美" })
    ).rejects.toThrow("120 songs");
    expect(calls.some((call) => call.path.endsWith("/downloadAlbum"))).toBe(
      false
    );
  });

  it("reads the kind from the tool arguments and keeps a song the default", () => {
    expect(
      parseSqMusicDownload({
        kind: "album",
        plugin: "kw",
        id: "A1",
        query: "叶惠美",
      })
    ).toEqual({ kind: "album", plugin: "kw", id: "A1", query: "叶惠美" });
    expect(
      parseSqMusicDownload({ plugin: "kw", id: "9", query: "晴天" })
    ).not.toHaveProperty("kind");
    expect(() =>
      parseSqMusicDownload({
        kind: "artist",
        plugin: "kw",
        id: "9",
        query: "x",
      })
    ).toThrow("kind");
    expect(
      parseSqMusicQuery({
        action: "search",
        kind: "album",
        plugin: "kw",
        query: "x",
      })
    ).toMatchObject({ kind: "album" });
  });
});
describe("music source wiring", () => {
  it("is absent without configuration and per-source with it", () => {
    expect(createMusicSourcesFromEnv({})).toBeUndefined();
    expect(
      Object.keys(
        createMusicSourcesFromEnv({
          THEBE_NETEASE_API_URL: "http://nas:13001",
        })!
      )
    ).toEqual(["netease"]);
    expect(
      createMusicSourcesFromEnv({
        THEBE_SQMUSIC_URL: "http://nas",
        THEBE_SQMUSIC_USERNAME: "u",
      })
    ).toBeUndefined();
  });
  it("validates tool arguments", () => {
    expect(parseNeteaseQuery({ action: "lyrics", id: "123" })).toMatchObject({
      action: "lyrics",
      id: "123",
    });
    expect(() => parseNeteaseQuery({ action: "lyrics", id: "12a" })).toThrow(
      "numeric"
    );
    expect(() => parseNeteaseQuery({ action: "search" })).toThrow("query");
    expect(() => parseSqMusicQuery({ action: "search", plugin: "kw" })).toThrow(
      "query"
    );
    expect(() =>
      parseSqMusicQuery({ action: "tasks", status: "bogus" })
    ).toThrow("status");
  });
});
