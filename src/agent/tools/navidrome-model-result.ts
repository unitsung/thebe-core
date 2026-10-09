import type { NavidromeToolName } from "../capabilities/navidrome.ts";

// Project model observations only. Product capability responses keep their full schema.
// Keep every returned candidate and its identity so follow-up playback stays grounded;
// drop fields a selection never needs (cross-reference ids repeated per row, track numbers, genre).
const BIOGRAPHY_LIMIT = 800;

export function navidromeModelResult(name: NavidromeToolName, result: unknown, args: Record<string, unknown> = {}): unknown {
  const value = object(result);
  if (!value) return result ?? null;
  switch (name) {
    case "navidrome.library":
      return project(value, {
        albums: album,
        artists: artist,
        songs: song,
        playlists: playlist,
      });
    case "navidrome.search":
      return project(value, { albums: album, artists: artist, songs: song });
    case "navidrome.artist":
      return {
        artist: artist(value.artist),
        biography: typeof value.biography === "string"
          ? value.biography.slice(0, BIOGRAPHY_LIMIT)
          : undefined,
        biographyTruncated: typeof value.biography === "string" && value.biography.length > BIOGRAPHY_LIMIT,
        similarArtists: Array.isArray(value.similarArtists) ? value.similarArtists.map(artist) : [],
      };
    case "navidrome.queue":
      return queueReceipt(value, args);
    default:
      // Lyrics, lyrics, and write receipts are required by their consumers.
      return result;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function fields(value: unknown, keys: string[]): unknown {
  const source = object(value);
  if (!source) return value;
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function song(value: unknown): unknown {
  return fields(value, ["id", "title", "artist", "album", "albumId", "duration"]);
}

function album(value: unknown): unknown {
  return fields(value, ["id", "name", "artist", "songCount", "year"]);
}

function artist(value: unknown): unknown {
  const source = object(value);
  return {
    ...object(fields(value, ["id", "name", "albumCount"])),
    ...(Array.isArray(source?.albums) ? { albums: source.albums.map(album) } : {}),
  };
}

function playlist(value: unknown): unknown {
  return fields(value, ["id", "name", "comment", "songCount", "duration"]);
}

function project(value: Record<string, unknown>, collections: Record<string, (item: unknown) => unknown>): unknown {
  return Object.fromEntries([
    ...(typeof value.mode === "string" ? [["mode", value.mode]] : []),
    ...Object.entries(collections)
      .filter(([key]) => Array.isArray(value[key]))
      .map(([key, convert]) => [key, (value[key] as unknown[]).map(convert)]),
  ]);
}

const RECEIPT_TRACKS = 10;

/**
 * The host app starts playback from `request`; the model gets a receipt, never stream URLs
 * (they carry the server's auth parameters and cost tokens on every later call).
 */
function queueReceipt(queue: Record<string, unknown>, args: Record<string, unknown>): unknown {
  const items = Array.isArray(queue.items) ? queue.items.map(object).filter((item) => item !== undefined) : [];
  const queued = items.length;
  const request = {
    ...(Array.isArray(args.songIds) ? { songIds: args.songIds.slice(0, queued) } : {}),
    ...(typeof args.albumId === "string" ? { albumId: args.albumId } : {}),
    ...(typeof args.playlistId === "string" ? { playlistId: args.playlistId } : {}),
    startIndex: queue.startIndex ?? 0,
    limit: queued,
  };
  return {
    queued,
    startIndex: queue.startIndex ?? 0,
    mode: queue.mode,
    request,
    tracks: items.slice(0, RECEIPT_TRACKS).map((item) => fields(item, ["queueId", "title", "artist", "album"])),
    ...(queued > RECEIPT_TRACKS ? { tracksOmitted: queued - RECEIPT_TRACKS } : {}),
    note: "The app plays this queue now. Do not write a player card or any stream URL.",
  };
}
