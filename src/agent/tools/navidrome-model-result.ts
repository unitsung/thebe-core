import type { NavidromeToolName } from "../capabilities/navidrome.ts";

// Project model observations only. Product capability responses keep their full schema.
// Keep every returned candidate and its identity so follow-up playback stays grounded;
// drop fields a selection never needs (cross-reference ids repeated per row, track numbers, genre).
const BIOGRAPHY_LIMIT = 800;

export function navidromeModelResult(name: NavidromeToolName, result: unknown): unknown {
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
    default:
      // Playback URLs, lyrics, and write receipts are required by their consumers.
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
