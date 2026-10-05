import { describe, expect, it, vi } from "vitest";
import { createMusicResearchProvider } from "./client.ts";
describe("music research evidence", () => {
  it("returns recording credits, albums and linked background instead of just lyrics", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ recordings: [{ id: "recording-id", title: "Song", "artist-credit": [{ name: "Artist" }], releases: [{ id: "album-id", title: "Album", date: "2020", unwanted: "x" }] }] }))).mockResolvedValueOnce(new Response(JSON.stringify({ query: { pages: { "1": { title: "Song", extract: "Background", fullurl: "https://en.wikipedia.org/wiki/Song" } } } })));
    const result = await createMusicResearchProvider(request).research({ query: "Song Artist", language: "en" }) as any;
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({ title: "Song", url: "https://musicbrainz.org/recording/recording-id", releases: [{ title: "Album", date: "2020" }] });
    expect(result.sources[0].releases[0]).not.toHaveProperty("unwanted");
    expect(result.sources[1]).toMatchObject({ text: "Background" });
    expect(new URL(String(request.mock.calls[1]![0])).searchParams.get("gsrsearch")).toBe("Song Artist");
  });
  it("preserves useful evidence when one source is unavailable", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ query: { pages: { "1": { title: "Artist", extract: "Biography" } } } })));
    const result = await createMusicResearchProvider(request).research({ query: "Artist", entity: "artist" }) as any;
    expect(result.sources).toHaveLength(1);
    expect(result.source_errors).toEqual(["MusicBrainz: HTTP 503"]);
  });
  it("reports empty and malformed responses without inventing facts", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ releases: [] }))).mockResolvedValueOnce(new Response("invalid"));
    const result = await createMusicResearchProvider(request).research({ query: "Unknown", entity: "release" }) as any;
    expect(result.sources).toEqual([]);
    expect(result.source_errors).toHaveLength(1);
  });
});
