import { describe, expect, it } from "vitest";
import {
  capabilityChangesThings,
  listCoreMcpTools,
  toMcpWireTool,
} from "./mcp.ts";

const everything = {
  strmRepairProvider: {} as never,
  navidrome: true,
  musicResearch: true,
  netease: true,
  sqmusic: true,
  emby: true,
  jellyfin: true,
  immich: true,
};

/**
 * Pi runs whatever tool it is given, so Core's own classification is the only thing between a model and a
 * write. Naming every tool here means a new one cannot slip in as "read" unseen: adding a capability fails
 * this test until a person has decided which list it belongs to.
 */
const WRITES = [
  "container.restart",
  "navidrome.playlist.create",
  "navidrome.playlist.delete",
  "navidrome.playlist.update",
  "sqmusic_download",
  "strm.repair",
];

const READS = [
  "container.inspect",
  "container.list",
  "container.logs",
  "container.status_summary",
  "diagnose_from_events",
  "emby.item",
  "emby.libraries",
  "emby.recent",
  "emby.search",
  "emby.sessions",
  "immich.albums",
  "immich.assets",
  "immich.search",
  "immich.statistics",
  "jellyfin.item",
  "jellyfin.libraries",
  "jellyfin.recent",
  "jellyfin.search",
  "jellyfin.sessions",
  "list_core_events",
  "music_research",
  "navidrome.artist",
  "navidrome.library",
  "navidrome.lyrics",
  "navidrome.queue",
  "navidrome.search",
  "netease_music",
  "sqmusic_search",
];

describe("what Core's own capabilities may change", () => {
  const tools = listCoreMcpTools(everything);

  it("names every write, and every read, so a new capability needs a decision", () => {
    const writes = tools.filter(capabilityChangesThings).map((t) => t.id);
    const reads = tools
      .filter((t) => !capabilityChangesThings(t))
      .map((t) => t.id);
    expect(writes.sort()).toEqual(WRITES);
    expect(reads.sort()).toEqual(READS);
  });

  it("never shows a write to a client as read-only", () => {
    for (const tool of tools.filter(capabilityChangesThings)) {
      expect(toMcpWireTool(tool).annotations?.readOnlyHint, tool.id).toBe(
        false
      );
    }
  });

  it("treats a tool that declares nothing as a write, not as a read", () => {
    expect(capabilityChangesThings({ permission: "confirm" })).toBe(true);
    expect(
      capabilityChangesThings({ permission: "read", effect: "write" })
    ).toBe(true);
    expect(capabilityChangesThings({ permission: "read" })).toBe(false);
  });
});
