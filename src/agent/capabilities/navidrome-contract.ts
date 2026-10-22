import {
  NAVIDROME_CAPABILITY_METADATA,
  NAVIDROME_LIBRARY_MODES,
  NAVIDROME_TOOL_NAMES,
  NAVIDROME_TOOL_SCHEMAS,
  type NavidromeLyrics,
  type NavidromeQueue,
} from "./navidrome.ts";

/**
 * The part of the Navidrome capabilities a client depends on, exported as data. Core owns it; a
 * client can check its requests and decoders against it.
 */
export const NAVIDROME_CONTRACT_PATH = "contracts/navidrome-capabilities.json";

/** A queue as a client receives it from `navidrome.queue`, with a real two-item shape. */
export const NAVIDROME_QUEUE_EXAMPLE = {
  items: [
    {
      queueId: "song-1",
      streamUrl: "https://music.example/rest/stream.view?id=song-1&format=raw",
      requestHeaders: {},
      title: "First",
      artist: "Artist",
      album: "Album",
      artworkUrl:
        "https://music.example/rest/getCoverArt.view?id=al-1&size=600",
      artworkHeaders: {},
      lyrics: {
        synced: true,
        offsetMilliseconds: 0,
        lines: [{ startMilliseconds: 1000, text: "line" }],
      },
      duration: 215,
      year: 2020,
      albumId: "al-1",
      artistId: "ar-1",
    },
    {
      queueId: "song-2",
      streamUrl: "https://music.example/rest/stream.view?id=song-2&format=raw",
      requestHeaders: {},
      title: "Second",
      artist: "Artist",
      album: "Album",
    },
  ],
  startIndex: 0,
  mode: "direct",
} satisfies NavidromeQueue;

export const NAVIDROME_LYRICS_EXAMPLE = {
  synced: false,
  lines: [{ text: "plain line" }],
} satisfies NavidromeLyrics;

export function buildNavidromeContract() {
  return {
    version: 1,
    libraryModes: [...NAVIDROME_LIBRARY_MODES],
    capabilities: Object.fromEntries(
      NAVIDROME_TOOL_NAMES.map((name) => [
        name,
        {
          ...NAVIDROME_CAPABILITY_METADATA[name],
          inputSchema: NAVIDROME_TOOL_SCHEMAS[name],
        },
      ])
    ),
    examples: {
      "navidrome.queue": NAVIDROME_QUEUE_EXAMPLE,
      "navidrome.lyrics": NAVIDROME_LYRICS_EXAMPLE,
    },
  };
}
