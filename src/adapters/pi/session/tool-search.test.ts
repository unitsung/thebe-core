import { describe, expect, it } from "vitest";
import { rankTools, type SearchableTool } from "./tool-search.ts";

const tools: SearchableTool[] = [
  {
    name: "navidrome.search",
    description:
      "Search the Navidrome music library for songs, albums and artists.",
  },
  {
    name: "navidrome.library",
    description:
      "Browse the Navidrome music library: recent albums, random songs, playlists.",
  },
  {
    name: "emby.search",
    description: "Search the Emby media library for movies and series.",
  },
  {
    name: "immich.search",
    description: "Search Immich photos by filename, date or place.",
  },
  {
    name: "arcane.images",
    description: "List container images on an Arcane host.",
  },
  {
    name: "download.status",
    description: "Show what is downloading and how far along.",
  },
];
const names = (query: string) => rankTools(query, tools, 8).map((m) => m.name);

describe("relevant tool search", () => {
  it("finds the tools a real request needs", () => {
    expect(names("play music song")).toContain("navidrome.search");
    expect(names("recently added movies")).toEqual(["emby.search"]);
    expect(names("download progress")).toEqual(["download.status"]);
  });

  it("returns nothing when a query only shares a word with a tool", () => {
    // "image" alone is in arcane.images, but the query asks for something else.
    expect(names("analyze image describe picture")).toEqual([]);
    expect(names("relaxing sleep sounds playlist ambient")).toEqual([]);
  });

  it("keeps a single-term query working", () => {
    expect(names("photos")).toEqual(["immich.search"]);
  });
});
