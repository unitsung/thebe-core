import { describe, expect, it } from "vitest";
import { JellyfinAdapter } from "./adapter.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const USER_ID = "0381cf93-1f9e-42d7-9fb9-c89f729167df";

describe("JellyfinAdapter", () => {
  it("lists libraries, recent items, and sessions with MediaBrowser Token", async () => {
    const seen: { url: string; authorization: string | null; embyToken: string | null }[] =
      [];
    const adapter = new JellyfinAdapter({
      baseUrl: "http://jellyfin.internal:8096",
      apiKey: "jf-key",
      userId: USER_ID,
      fetch: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        seen.push({
          url,
          authorization: headers.get("Authorization"),
          embyToken: headers.get("X-Emby-Token"),
        });
        if (url.includes("/Views")) {
          return jsonResponse(200, {
            Items: [
              {
                Name: "TV",
                Id: "lib-tv",
                CollectionType: "tvshows",
              },
            ],
          });
        }
        if (url.includes("/Items/Latest")) {
          return jsonResponse(200, [
            {
              Name: "Dune: Prophecy",
              Id: "item-dune",
              Type: "Series",
              ProductionYear: 2024,
            },
          ]);
        }
        if (url.endsWith("/Sessions")) {
          return jsonResponse(200, [
            {
              Id: "session-jf",
              UserName: "bob",
              Client: "Jellyfin Web",
              NowPlayingItem: {
                Name: "Dune: Prophecy",
                Id: "item-dune",
                Type: "Series",
              },
            },
          ]);
        }
        return jsonResponse(404, {});
      },
    });

    await expect(adapter.listLibraries()).resolves.toEqual([
      { id: "lib-tv", title: "TV", kind: "tvshows" },
    ]);
    await expect(adapter.listRecent()).resolves.toEqual([
      {
        id: "item-dune",
        title: "Dune: Prophecy",
        type: "Series",
        year: 2024,
      },
    ]);
    await expect(adapter.listSessions()).resolves.toEqual([
      {
        id: "session-jf",
        title: "Dune: Prophecy",
        client: "Jellyfin Web",
        userName: "bob",
      },
    ]);
    expect(seen.every((row) => row.authorization === 'MediaBrowser Token="jf-key"')).toBe(
      true,
    );
    expect(seen.every((row) => row.embyToken === null)).toBe(true);
    expect(seen.map((row) => row.url)).toEqual([
      `http://jellyfin.internal:8096/Users/${USER_ID}/Views`,
      `http://jellyfin.internal:8096/Users/${USER_ID}/Items/Latest?Limit=20`,
      "http://jellyfin.internal:8096/Sessions",
    ]);
  });
});
