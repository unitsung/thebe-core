import { describe, expect, it } from "vitest";
import { EmbyAdapter } from "./adapter.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const USER_ID = "e8837bc1-ad67-520e-8cd2-f629e3155721";

describe("EmbyAdapter", () => {
  it("lists libraries, recent items, and sessions with X-Emby-Token", async () => {
    const seen: { url: string; token: string | null }[] = [];
    const adapter = new EmbyAdapter({
      baseUrl: "http://emby.internal:8096",
      apiKey: "emby-key",
      userId: USER_ID,
      fetch: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        seen.push({ url, token: headers.get("X-Emby-Token") });
        if (url.includes("/Views")) {
          return jsonResponse(200, {
            Items: [
              {
                Name: "Movies",
                Id: "lib-movies",
                CollectionType: "movies",
              },
            ],
          });
        }
        if (url.includes("/Items/Latest")) {
          return jsonResponse(200, [
            {
              Name: "Arrival",
              Id: "item-arrival",
              Type: "Movie",
              ProductionYear: 2016,
            },
          ]);
        }
        if (url.endsWith("/emby/Sessions")) {
          return jsonResponse(200, [
            {
              Id: "session-1",
              UserName: "alice",
              Client: "Emby for iOS",
              NowPlayingItem: { Name: "Arrival", Id: "item-arrival", Type: "Movie" },
            },
          ]);
        }
        return jsonResponse(404, {});
      },
    });

    await expect(adapter.listLibraries()).resolves.toEqual([
      { id: "lib-movies", title: "Movies", kind: "movies" },
    ]);
    await expect(adapter.listRecent()).resolves.toEqual([
      { id: "item-arrival", title: "Arrival", type: "Movie", year: 2016 },
    ]);
    await expect(adapter.listSessions()).resolves.toEqual([
      {
        id: "session-1",
        title: "Arrival",
        client: "Emby for iOS",
        userName: "alice",
      },
    ]);
    expect(seen.every((row) => row.token === "emby-key")).toBe(true);
    expect(seen.map((row) => row.url)).toEqual([
      `http://emby.internal:8096/emby/Users/${USER_ID}/Views`,
      `http://emby.internal:8096/emby/Users/${USER_ID}/Items/Latest?Limit=20`,
      "http://emby.internal:8096/emby/Sessions",
    ]);
    expect(seen.some((row) => row.url.toLowerCase().includes("authorization"))).toBe(
      false,
    );
  });

  it("searches items and reads one item, treating 404 as missing", async () => {
    const seen: string[] = [];
    const adapter = new EmbyAdapter({
      baseUrl: "http://emby.internal:8096/",
      apiKey: "emby-key",
      userId: USER_ID,
      fetch: async (input, init) => {
        const url = String(input);
        seen.push(url);
        const headers = new Headers(init?.headers);
        expect(headers.get("X-Emby-Token")).toBe("emby-key");
        if (url.includes("SearchTerm=Arrival")) {
          return jsonResponse(200, {
            Items: [{
              Name: "Arrival",
              Id: "item-arrival",
              Type: "Movie",
              ProductionYear: 2016,
              Overview: "A linguist meets visitors.",
              Genres: ["Drama"],
              CommunityRating: 7.9,
              People: [{ Name: "Amy Adams", Id: "person-1", Role: "Louise", Type: "Actor" }],
              ProviderIds: { Imdb: "tt2543164" },
            }],
            TotalRecordCount: 1,
          });
        }
        if (url.endsWith("/missing")) return jsonResponse(404, {});
        return jsonResponse(200, {
          Name: "Arrival",
          Id: "item-arrival",
          Type: "Movie",
          ProductionYear: 2016,
          Overview: "A linguist meets visitors.",
        });
      },
    });

    await expect(adapter.searchItems({
      query: "Arrival",
      person: "Amy Adams",
      year: 2016,
      limit: 100,
    })).resolves.toEqual({
      items: [{
        id: "item-arrival",
        title: "Arrival",
        type: "Movie",
        year: 2016,
        overview: "A linguist meets visitors.",
        genres: ["Drama"],
        communityRating: 7.9,
        people: [{ id: "person-1", name: "Amy Adams", role: "Louise", type: "Actor" }],
        providerIds: { Imdb: "tt2543164" },
      }],
      total: 1,
    });
    const search = new URL(seen[0]!);
    expect(search.pathname).toBe(`/emby/Users/${USER_ID}/Items`);
    expect(search.searchParams.get("SearchTerm")).toBe("Arrival");
    expect(search.searchParams.get("Person")).toBe("Amy Adams");
    expect(search.searchParams.get("Years")).toBe("2016");
    expect(search.searchParams.get("Limit")).toBe("40");
    expect(search.searchParams.get("Recursive")).toBe("true");
    expect(search.searchParams.get("Fields")).toBe("Overview,Genres,People,ProviderIds");

    await expect(adapter.getItem("item-arrival")).resolves.toMatchObject({
      id: "item-arrival",
      title: "Arrival",
    });
    await expect(adapter.getItem("missing")).resolves.toBeUndefined();
    expect(seen[1]).toBe(
      `http://emby.internal:8096/emby/Users/${USER_ID}/Items/item-arrival`,
    );
  });
});
