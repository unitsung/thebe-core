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
  "container_restart",
  "navidrome_playlist_create",
  "navidrome_playlist_delete",
  "navidrome_playlist_update",
  "sqmusic_download",
  "strm_repair",
  "ticket_control",
  "ticket_delegate",
  "ticket_note",
  "ticket_reply",
];

const READS = [
  "container_inspect",
  "container_list",
  "container_logs",
  "container_status_summary",
  "diagnose_from_events",
  "emby_item",
  "emby_libraries",
  "emby_recent",
  "emby_search",
  "emby_sessions",
  "immich_albums",
  "immich_assets",
  "immich_search",
  "immich_statistics",
  "jellyfin_item",
  "jellyfin_libraries",
  "jellyfin_recent",
  "jellyfin_search",
  "jellyfin_sessions",
  "list_core_events",
  "music_research",
  "navidrome_artist",
  "navidrome_library",
  "navidrome_lyrics",
  "navidrome_queue",
  "navidrome_search",
  "netease_music",
  "sqmusic_search",
  "ticket_get",
  "ticket_list",
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
