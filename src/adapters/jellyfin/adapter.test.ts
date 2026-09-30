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

  it("strips /api suffix from configured baseUrl", async () => {
    let requestedUrl = "";
    const adapter = new JellyfinAdapter({
      baseUrl: "http://jellyfin.internal:8096/api/",
      apiKey: "jf-key",
      userId: USER_ID,
      fetch: async (input) => {
        requestedUrl = String(input);
        return jsonResponse(200, []);
      },
    });
    await adapter.listSessions();
    expect(requestedUrl).toBe("http://jellyfin.internal:8096/Sessions");
  });

  it("searches with OpenAPI camelCase and reads one item", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const adapter = new JellyfinAdapter({
      baseUrl: "http://jellyfin.internal:8096",
      apiKey: "jf-key",
      userId: USER_ID,
      fetch: async (input, init) => {
        const url = String(input);
        seen.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
        if (url.includes("searchTerm=Dune")) {
          return jsonResponse(200, {
            Items: [{ Name: "Dune", Id: "item-dune", Type: "Movie", ProductionYear: 2021 }],
            TotalRecordCount: 1,
          });
        }
        if (url.endsWith("/gone")) return jsonResponse(404, {});
        return jsonResponse(200, { Name: "Dune", Id: "item-dune", Type: "Movie" });
      },
    });

    await expect(adapter.searchItems({ query: "Dune", year: 2021 })).resolves.toMatchObject({
      total: 1,
      items: [{ id: "item-dune", title: "Dune", year: 2021 }],
    });
    const search = new URL(seen[0]!.url);
    expect(search.pathname).toBe(`/Users/${USER_ID}/Items`);
    expect(search.searchParams.get("searchTerm")).toBe("Dune");
    expect(search.searchParams.get("years")).toBe("2021");
    expect(search.searchParams.get("includeItemTypes")).toBe("Movie,Series");
    expect(search.searchParams.has("SearchTerm")).toBe(false);
    expect(seen[0]!.authorization).toBe('MediaBrowser Token="jf-key"');
    await expect(adapter.getItem("gone")).resolves.toBeUndefined();
  });
});
