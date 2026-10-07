import { describe, expect, it, vi } from "vitest";
import { QBittorrentBackgroundTaskProvider, createQBittorrentBackgroundTaskProviderFromEnv } from "./tasks.ts";

const hash = "a".repeat(40);
function fixture(version = "v5.0.0") {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith("auth/login")) return new Response("Ok.", { headers: { "set-cookie": "SID=canary; HttpOnly; Path=/" } });
    if (url.includes("torrents/info")) return Response.json([
      { hash, name: "Linux ISO", state: "stalledUP", progress: 1, added_on: 100, completion_on: 200, size: 1000, save_path: "/private/path" },
      { hash: "b".repeat(40), name: "Working", state: "downloading", progress: 0.5, added_on: 100 },
      { hash: "c".repeat(40), state: "missingFiles", progress: 0.1 },
      { hash: "bad" },
    ]);
    if (url.endsWith("app/version")) return new Response(version);
    return new Response("");
  });
  return { requests, fetchImpl, provider: new QBittorrentBackgroundTaskProvider({ baseUrl: "https://qbit.example", username: "user", password: "secret", fetch: fetchImpl }) };
}

describe("qBittorrent native tasks", () => {
  it("authenticates once, maps downloads and retains only allow-listed completion output", async () => {
    const f = fixture();
    const [rows] = await Promise.all([f.provider.list(), f.provider.list()]);
    expect(f.requests.filter(row => row.url.endsWith("auth/login"))).toHaveLength(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: hash, status: "stopped", finishedAt: "1970-01-01T00:03:20.000Z", output: { contentType: "application/json" } });
    expect(rows[1]?.status).toBe("running"); expect(rows[2]?.status).toBe("failed");
    expect(JSON.stringify(rows)).not.toMatch(/secret|canary|private\/path|save_path/);
    expect(f.requests[1]?.init?.headers).toMatchObject({ Cookie: "SID=canary", Referer: "https://qbit.example/" });
  });
  it.each([["v5.0.0", "stop"], ["v4.6.7", "pause"]])("uses the native pause endpoint for %s", async (version, action) => {
    const f = fixture(version); await f.provider.stop(hash);
    expect(f.requests.at(-1)?.url).toBe(`https://qbit.example/api/v2/torrents/${action}`);
    expect(String(f.requests.at(-1)?.init?.body)).toBe(`hashes=${hash}`);
    await expect(f.provider.stop("all")).rejects.toThrow("Invalid torrent hash");
  });
  it("stops only the bounded running download tasks, leaving completed torrents alone", async () => {
    const f = fixture(); await f.provider.stopAll();
    expect(f.requests.filter(row => row.url.endsWith("torrents/stop"))).toHaveLength(1);
    expect(String(f.requests.at(-1)?.init?.body)).toContain("b".repeat(40));
  });
  it("refreshes an expired session once and fails bad credentials without listing", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(new Response("Fails."));
    await expect(f.provider.list()).rejects.toThrow("login failed");
    expect(f.requests).toHaveLength(0);
    expect(createQBittorrentBackgroundTaskProviderFromEnv({})).toBeUndefined();
  });
});
