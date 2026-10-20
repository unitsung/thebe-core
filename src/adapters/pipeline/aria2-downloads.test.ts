import { describe, expect, it, vi } from "vitest";
import {
  Aria2DownloadProvider,
  createAria2DownloadProviderFromEnv,
} from "./aria2-downloads.ts";

const gid = "0123456789abcdef";

type Rpc = { method: string; params: unknown[] };

/** An aria2 that answers each RPC method from `answers`, and records what it was asked. */
function aria(
  answers: Record<string, unknown | ((params: unknown[]) => unknown)> = {},
  options: { secret?: string; baseUrl?: string } = {}
) {
  const calls: Rpc[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Rpc;
    calls.push({ method: body.method, params: body.params });
    const answer = answers[body.method];
    const result = typeof answer === "function" ? answer(body.params) : answer;
    if (result instanceof Error)
      return Response.json(
        {
          jsonrpc: "2.0",
          id: "thebe",
          error: { code: 1, message: result.message },
        },
        { status: 400 }
      );
    return Response.json({ jsonrpc: "2.0", id: "thebe", result: result ?? [] });
  });
  const provider = new Aria2DownloadProvider({
    baseUrl: options.baseUrl ?? "https://a.example:6800",
    secret: options.secret,
    fetch: fetchImpl,
  });
  return { provider, calls, fetchImpl };
}

const row = (extra: Record<string, unknown> = {}) => ({
  gid,
  status: "active",
  totalLength: "1000",
  completedLength: "250",
  downloadSpeed: "50",
  dir: "/downloads",
  files: [{ path: "/downloads/Movie.2024.mkv" }],
  ...extra,
});

describe("aria2 downloads", () => {
  it("adds one download per link, with the folder, and sends the RPC secret as a token", async () => {
    const { provider, calls, fetchImpl } = aria(
      { "aria2.addUri": gid },
      { secret: "s3cret" }
    );

    const result = await provider.add({
      urls: ["https://f.example/a.iso", "magnet:?xt=urn:btih:abc"],
      savePath: "/downloads/tv",
      paused: true,
    });

    expect(result).toEqual({ submitted: 2, engine: "aria2" });
    expect(calls).toEqual([
      {
        method: "aria2.addUri",
        params: [
          "token:s3cret",
          ["https://f.example/a.iso"],
          { dir: "/downloads/tv", pause: "true" },
        ],
      },
      {
        method: "aria2.addUri",
        params: [
          "token:s3cret",
          ["magnet:?xt=urn:btih:abc"],
          { dir: "/downloads/tv", pause: "true" },
        ],
      },
    ]);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://a.example:6800/jsonrpc"
    );
  });

  it("takes the RPC address with or without /jsonrpc and works without a secret", async () => {
    const { provider, fetchImpl, calls } = aria(
      { "aria2.addUri": gid },
      { baseUrl: "http://nas:6800/jsonrpc/" }
    );
    await provider.add({ urls: ["https://f.example/a.iso"] });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://nas:6800/jsonrpc");
    expect(calls[0]!.params[0]).toEqual(["https://f.example/a.iso"]);
  });

  it("rejects links aria2 should not be given before sending anything", async () => {
    const { provider, calls } = aria();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp//x"])
      await expect(provider.add({ urls: [url] })).rejects.toThrow(
        /Unsupported download source/
      );
    await expect(provider.add({ urls: ["  "] })).rejects.toThrow(
      /At least one URL/
    );
    expect(calls).toEqual([]);
  });

  it("lists active, waiting and the most recently stopped, and reads size, speed, ETA and folder", async () => {
    const { provider, calls } = aria({
      "aria2.tellActive": [row()],
      "aria2.tellWaiting": [
        row({
          gid: "aaaaaaaaaaaaaaaa",
          status: "paused",
          totalLength: "0",
          completedLength: "0",
          files: [],
        }),
      ],
      "aria2.tellStopped": [
        row({
          gid: "bbbbbbbbbbbbbbbb",
          status: "error",
          completedLength: "10",
          errorMessage: "File not found",
        }),
      ],
    });

    const items = await provider.list({ limit: 10 });

    expect(items.map((item) => [item.id, item.phase])).toEqual([
      [gid, "downloading"],
      ["aaaaaaaaaaaaaaaa", "paused"],
      ["bbbbbbbbbbbbbbbb", "error"],
    ]);
    expect(items[0]).toMatchObject({
      engine: "aria2",
      hash: gid,
      name: "Movie.2024.mkv",
      progress: 0.25,
      sizeBytes: 1000,
      downloadSpeedBytes: 50,
      etaSeconds: 15,
      savePath: "/downloads",
      contentPath: "/downloads/Movie.2024.mkv",
    });
    expect(items[2]!.message).toBe("File not found");
    expect(
      calls.find((call) => call.method === "aria2.tellStopped")!.params
    ).toEqual([-1, 10, expect.arrayContaining(["gid", "status"])]);
  });

  it("filters by phase and names a torrent by its own name", async () => {
    const { provider } = aria({
      "aria2.tellActive": [
        row({
          bittorrent: { info: { name: "Show.S01" } },
          files: [{ path: "/downloads/Show.S01/e1.mkv" }],
        }),
      ],
      "aria2.tellStopped": [
        row({ gid: "bbbbbbbbbbbbbbbb", status: "complete" }),
      ],
    });
    const completed = await provider.list({ filter: "completed" });
    expect(completed.map((item) => item.id)).toEqual(["bbbbbbbbbbbbbbbb"]);
    const [active] = await provider.list({ filter: "downloading" });
    expect(active).toMatchObject({
      name: "Show.S01",
      contentPath: "/downloads/Show.S01",
    });
  });

  it("reads one download, and says undefined once aria2 no longer knows it", async () => {
    const found = aria({ "aria2.tellStatus": row() });
    expect((await found.provider.get(gid))?.id).toBe(gid);

    const gone = aria({
      "aria2.tellStatus": new Error(`GID ${gid} is not found`),
    });
    expect(await gone.provider.get(gid)).toBeUndefined();
    await expect(gone.provider.get("nope")).rejects.toThrow(/Invalid aria2 id/);
  });

  it("reports a refused secret as unauthorized and other errors with aria2's own words", async () => {
    const refused = aria({ "aria2.tellActive": new Error("Unauthorized") });
    await expect(refused.provider.list({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const failing = aria({ "aria2.addUri": new Error("URI is invalid") });
    await expect(
      failing.provider.add({ urls: ["https://f.example/a"] })
    ).rejects.toThrow(/aria2: URI is invalid/);
  });

  it("pauses and resumes only downloads it knows, and sends nothing for an unknown one", async () => {
    const known = aria({ "aria2.tellStatus": row() });
    await known.provider.pause([gid]);
    await known.provider.resume([gid, gid.toUpperCase()]);
    expect(known.calls.map((call) => call.method)).toEqual([
      "aria2.tellStatus",
      "aria2.pause",
      "aria2.tellStatus",
      "aria2.unpause",
    ]);

    const unknown = aria({
      "aria2.tellStatus": new Error("GID x is not found"),
    });
    await expect(unknown.provider.pause([gid])).rejects.toThrow(
      /Unknown download/
    );
    await expect(unknown.provider.pause(["zz"])).rejects.toThrow(
      /Invalid aria2 id/
    );
    await expect(unknown.provider.pause([])).rejects.toThrow(
      /between 1 and 20/
    );
    expect(unknown.calls.map((call) => call.method)).not.toContain(
      "aria2.pause"
    );
  });

  it("removes an unfinished task and forgets its record; the owner's script clears the files", async () => {
    const { provider, calls } = aria({ "aria2.tellStatus": row() });
    await provider.remove([gid], true);
    expect(calls.map((call) => call.method)).toEqual([
      "aria2.tellStatus",
      "aria2.forceRemove",
      "aria2.removeDownloadResult",
    ]);
  });

  it("only forgets the record of a finished task, and refuses to promise its files gone", async () => {
    const { provider, calls } = aria({
      "aria2.tellStatus": row({ status: "complete" }),
    });
    await provider.remove([gid], false);
    expect(calls.map((call) => call.method)).toEqual([
      "aria2.tellStatus",
      "aria2.removeDownloadResult",
    ]);

    const before = calls.length;
    await expect(provider.remove([gid], true)).rejects.toThrow(
      /cannot delete the files of a finished download/
    );
    expect(calls.slice(before).map((call) => call.method)).toEqual([
      "aria2.tellStatus",
    ]);
  });

  it("is set up from THEBE_ARIA2_URL and the optional THEBE_ARIA2_SECRET", () => {
    expect(createAria2DownloadProviderFromEnv({})).toBeUndefined();
    expect(
      createAria2DownloadProviderFromEnv({ THEBE_ARIA2_URL: "http://nas:6800" })
    ).toBeInstanceOf(Aria2DownloadProvider);
  });
});
