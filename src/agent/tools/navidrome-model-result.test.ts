import { describe, expect, it } from "vitest";
import { navidromeModelResult } from "./navidrome-model-result.ts";

describe("navidromeModelResult", () => {
  it("keeps candidate identity and drops fields a selection never needs", () => {
    const result = navidromeModelResult("navidrome.search", {
      songs: [{ id: "s1", title: "T", artist: "A", artistId: "a1", album: "Al", albumId: "al1", duration: 200, track: 3, discNumber: 1, year: 1999 }],
      albums: [{ id: "al1", name: "Al", artist: "A", artistId: "a1", songCount: 12, duration: 2800, year: 1999, genre: "Pop" }],
      artists: [{ id: "a1", name: "A", albumCount: 4, albums: [] }],
    }) as { songs: [unknown]; albums: [unknown]; artists: [unknown] };
    expect(result.songs[0]).toEqual({ id: "s1", title: "T", artist: "A", album: "Al", albumId: "al1", duration: 200 });
    expect(result.albums[0]).toEqual({ id: "al1", name: "Al", artist: "A", songCount: 12, year: 1999 });
    expect(result.artists[0]).toEqual({ id: "a1", name: "A", albumCount: 4, albums: [] });
  });

  it("bounds a long biography and says so", () => {
    const result = navidromeModelResult("navidrome.artist", {
      artist: { id: "a1", name: "A" },
      biography: "x".repeat(2000),
      similarArtists: [],
    }) as { biography: string; biographyTruncated: boolean };
    expect(result.biography.length).toBe(800);
    expect(result.biographyTruncated).toBe(true);
  });

  it("turns a queue into a receipt with no stream URLs or auth parameters", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      queueId: `q${i}`, title: `T${i}`, artist: "A", album: "Al",
      streamUrl: `http://nas/rest/stream.view?u=admin&t=SECRET&s=SALT&id=q${i}`,
      artworkUrl: "http://nas/rest/getCoverArt.view?t=SECRET", requestHeaders: {}, artworkHeaders: {},
    }));
    const receipt = navidromeModelResult(
      "navidrome.queue",
      { items, startIndex: 2, mode: "direct" },
      { songIds: items.map((item) => item.queueId), startIndex: 2 },
    ) as { queued: number; request: { songIds: string[]; startIndex: number }; tracks: unknown[]; tracksOmitted: number };
    const text = JSON.stringify(receipt);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("stream.view");
    expect(receipt.queued).toBe(25);
    expect(receipt.request.songIds).toHaveLength(25);
    expect(receipt.request.startIndex).toBe(2);
    expect(receipt.tracks).toHaveLength(10);
    expect(receipt.tracksOmitted).toBe(15);
  });
});
