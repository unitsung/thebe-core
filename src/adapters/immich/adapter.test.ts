import { describe, expect, it } from "vitest";
import { ImmichAdapter } from "./adapter.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ImmichAdapter", () => {
  it("lists assets, albums, and statistics with x-api-key", async () => {
    const seen: {
      url: string;
      method: string;
      key: string | null;
      authorization: string | null;
    }[] = [];
    const adapter = new ImmichAdapter({
      baseUrl: "https://immich.internal:2283",
      apiKey: "immich-key",
      fetch: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        seen.push({
          url,
          method: init?.method ?? "GET",
          key: headers.get("x-api-key"),
          authorization: headers.get("Authorization"),
        });
        if (url.endsWith("/search/metadata")) {
          return jsonResponse(200, {
            assets: {
              items: [
                {
                  id: "233a91cf-524b-4c80-99a7-39ad92d6624e",
                  originalFileName: "PXL_20220723_175547589.NIGHT.jpg",
                  type: "IMAGE",
                },
              ],
            },
          });
        }
        if (url.endsWith("/albums")) {
          return jsonResponse(200, [
            {
              id: "album-trip",
              albumName: "Coast trip",
              assetCount: 12,
            },
          ]);
        }
        if (url.endsWith("/assets/statistics")) {
          return jsonResponse(200, { images: 10, videos: 23, total: 33 });
        }
        return jsonResponse(404, {});
      },
    });

    await expect(adapter.listAssets()).resolves.toEqual([
      {
        id: "233a91cf-524b-4c80-99a7-39ad92d6624e",
        title: "PXL_20220723_175547589.NIGHT.jpg",
        type: "IMAGE",
      },
    ]);
    await expect(adapter.listAlbums()).resolves.toEqual([
      { id: "album-trip", title: "Coast trip", assetCount: 12 },
    ]);
    await expect(adapter.getStatistics()).resolves.toEqual({
      images: 10,
      videos: 23,
      total: 33,
    });
    expect(seen.every((row) => row.key === "immich-key")).toBe(true);
    expect(seen.every((row) => row.authorization === null)).toBe(true);
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://immich.internal:2283/api/search/metadata",
          method: "POST",
        }),
        expect.objectContaining({
          url: "https://immich.internal:2283/api/albums",
          method: "GET",
        }),
        expect.objectContaining({
          url: "https://immich.internal:2283/api/assets/statistics",
          method: "GET",
        }),
      ]),
    );
  });
});
