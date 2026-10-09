export const NAVIDROME_PROVIDER_ID = "navidrome";

export type NavidromeLibraryMode =
  | "recent"
  | "recently_played"
  | "albums"
  | "artists"
  | "playlists"
  | "songs"
  | "recommended"
  | "random"
  | "frequent"
  | "highest"
  | "starred";

export type NavidromeAlbumListType =
  | "random"
  | "newest"
  | "highest"
  | "frequent"
  | "recent"
  | "alphabeticalByName"
  | "alphabeticalByArtist"
  | "starred";

export type NavidromePlaybackMode = "direct" | "transcode";

export type NavidromeAlbum = {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  year?: number;
  genre?: string;
  created?: string;
  songs?: NavidromeSong[];
};

export type NavidromeSong = {
  id: string;
  title: string;
  artist?: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  coverArt?: string;
  duration?: number;
  track?: number;
  discNumber?: number;
  year?: number;
  suffix?: string;
  contentType?: string;
  bitRate?: number;
  bitDepth?: number;
  samplingRate?: number;
  channelCount?: number;
  size?: number;
};

export type NavidromeArtist = {
  id: string;
  name: string;
  coverArt?: string;
  albumCount?: number;
  albums?: NavidromeAlbum[];
};

export type NavidromeArtistDetails = {
  artist: NavidromeArtist;
  biography?: string;
  musicBrainzId?: string;
  lastFmUrl?: string;
  smallImageUrl?: string;
  mediumImageUrl?: string;
  largeImageUrl?: string;
  similarArtists: NavidromeArtist[];
};

export type NavidromeSearchResult = {
  artists: NavidromeArtist[];
  albums: NavidromeAlbum[];
  songs: NavidromeSong[];
};

export type NavidromePlaylist = {
  id: string;
  name: string;
  comment?: string;
  owner?: string;
  isPublic?: boolean;
  songCount?: number;
  duration?: number;
  coverArt?: string;
  created?: string;
  changed?: string;
  songs?: NavidromeSong[];
};

export type NavidromeLyricsLine = {
  startMilliseconds?: number;
  text: string;
};

export type NavidromeLyrics = {
  synced: boolean;
  offsetMilliseconds?: number;
  lines: NavidromeLyricsLine[];
};

export type NavidromeQueueItem = {
  queueId: string;
  streamUrl: string;
  requestHeaders: Record<string, string>;
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  artworkHeaders?: Record<string, string>;
  lyrics?: NavidromeLyrics;
  duration?: number;
  year?: number;
};

export type NavidromeQueue = {
  items: NavidromeQueueItem[];
  startIndex: number;
  mode: NavidromePlaybackMode;
  maxBitRate?: number;
};

export type NavidromeLibraryInput = {
  mode: NavidromeLibraryMode;
  limit: number;
  offset: number;
};

export type NavidromeLibraryResult =
  | {
      mode:
        | "recent"
        | "recently_played"
        | "albums"
        | "recommended"
        | "random"
        | "frequent"
        | "highest"
        | "starred";
      albums: NavidromeAlbum[];
    }
  | { mode: "artists"; artists: NavidromeArtist[] }
  | { mode: "playlists"; playlists: NavidromePlaylist[] }
  | { mode: "songs"; songs: NavidromeSong[] };

export type NavidromeQueueInput = {
  songIds?: string[];
  albumId?: string;
  playlistId?: string;
  startIndex?: number;
  mode?: NavidromePlaybackMode;
  maxBitRate?: number;
  limit?: number;
  includeLyrics?: boolean;
};

export type NavidromeCreatePlaylistInput = {
  name: string;
  songIds?: string[];
};

export type NavidromeUpdatePlaylistInput = {
  playlistId: string;
  name?: string;
  comment?: string;
  isPublic?: boolean;
  addSongIds?: string[];
  removeSongIndexes?: number[];
};

/**
 * Agent-owned Navidrome boundary. The adapter owns Subsonic authentication,
 * response mapping, and generation of provider-native playback URLs.
 */
export interface NavidromeProvider {
  readonly service: string;
  listLibrary(input: NavidromeLibraryInput): Promise<NavidromeLibraryResult>;
  search(query: string, limit: number): Promise<NavidromeSearchResult>;
  getArtist(id: string, limit?: number): Promise<NavidromeArtistDetails | undefined>;
  getLyrics(songId: string): Promise<NavidromeLyrics | undefined>;
  getPlaybackQueue(input: NavidromeQueueInput): Promise<NavidromeQueue>;
  createPlaylist(
    input: NavidromeCreatePlaylistInput,
  ): Promise<NavidromePlaylist | undefined>;
  updatePlaylist(input: NavidromeUpdatePlaylistInput): Promise<void>;
  deletePlaylist(id: string): Promise<void>;
}

export const NAVIDROME_READ_TOOL_NAMES = [
  "navidrome.library",
  "navidrome.search",
  "navidrome.artist",
  "navidrome.lyrics",
  "navidrome.queue",
] as const;

export const NAVIDROME_WRITE_TOOL_NAMES = [
  "navidrome.playlist.create",
  "navidrome.playlist.update",
  "navidrome.playlist.delete",
] as const;

export const NAVIDROME_TOOL_NAMES = [
  ...NAVIDROME_READ_TOOL_NAMES,
  ...NAVIDROME_WRITE_TOOL_NAMES,
] as const;

export type NavidromeToolName = (typeof NAVIDROME_TOOL_NAMES)[number];

export const NAVIDROME_LIBRARY_MODES = [
  "recent",
  "recently_played",
  "albums",
  "artists",
  "playlists",
  "songs",
  "recommended",
  "random",
  "frequent",
  "highest",
  "starred",
] as const satisfies readonly NavidromeLibraryMode[];

export const NAVIDROME_TOOL_SCHEMAS: Record<
  NavidromeToolName,
  Record<string, unknown>
> = {
  "navidrome.library": {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: NAVIDROME_LIBRARY_MODES,
        description: "Library view. Defaults to recent.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum items to return. Defaults to 30.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Zero-based result offset for paged modes.",
      },
    },
  },
  "navidrome.search": {
    type: "object",
    properties: {
      query: { type: "string", description: "Search terms." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 60,
        description: "Maximum matches per result type. Defaults to 10; raise it only when the results lack the needed matches.",
      },
    },
    required: ["query"],
  },
  "navidrome.artist": {
    type: "object",
    properties: {
      id: { type: "string", description: "Navidrome artist id." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Maximum similar artists. Defaults to 12.",
      },
    },
    required: ["id"],
  },
  "navidrome.lyrics": {
    type: "object",
    properties: {
      songId: { type: "string", description: "Navidrome song id." },
    },
    required: ["songId"],
  },
  "navidrome.queue": {
    type: "object",
    properties: {
      songIds: {
        type: "array",
        items: { type: "string" },
        description: "Ordered song ids to enqueue.",
      },
      albumId: {
        type: "string",
        description: "Queue an album by id instead of explicit song ids.",
      },
      playlistId: {
        type: "string",
        description: "Queue a playlist by id instead of explicit song ids.",
      },
      startIndex: {
        type: "integer",
        minimum: 0,
        description: "Zero-based item to start from. Defaults to 0.",
      },
      mode: {
        type: "string",
        enum: ["direct", "transcode"],
        description: "Direct stream or provider transcode. Defaults to direct.",
      },
      maxBitRate: {
        type: "integer",
        enum: [64, 128, 192, 256, 320],
        description: "Transcode bitrate in kbps. Defaults to 320.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Maximum queue items. Defaults to 100, at most 200.",
      },
      includeLyrics: {
        type: "boolean",
        description: "Fetch lyrics for every queue item. Defaults to false.",
      },
    },
  },
  "navidrome.playlist.create": {
    type: "object",
    properties: {
      name: { type: "string", description: "Playlist name." },
      songIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional ordered song ids.",
      },
    },
    required: ["name"],
  },
  "navidrome.playlist.update": {
    type: "object",
    properties: {
      playlistId: { type: "string", description: "Navidrome playlist id." },
      name: { type: "string", description: "Optional new name." },
      comment: { type: "string", description: "Optional description." },
      isPublic: { type: "boolean", description: "Optional public flag." },
      addSongIds: {
        type: "array",
        items: { type: "string" },
        description: "Song ids to append.",
      },
      removeSongIndexes: {
        type: "array",
        items: { type: "integer", minimum: 0 },
        description: "Zero-based playlist indexes to remove.",
      },
    },
    required: ["playlistId"],
  },
  "navidrome.playlist.delete": {
    type: "object",
    properties: {
      playlistId: { type: "string", description: "Navidrome playlist id." },
    },
    required: ["playlistId"],
  },
};

export const NAVIDROME_TOOL_DESCRIPTIONS: Record<NavidromeToolName, string> = {
  "navidrome.library":
    "Browse the Navidrome music library: recent, recently played, albums, artists, playlists, songs, or recommendations",
  "navidrome.search": "Search Navidrome artists, albums, and songs",
  "navidrome.artist": "Read one Navidrome artist, biography, albums, and similar artists",
  "navidrome.lyrics": "Read structured or plain lyrics for one Navidrome song",
  "navidrome.queue":
    "Build a provider-neutral playback queue with Navidrome stream and artwork URLs",
  "navidrome.playlist.create":
    "Create a Navidrome playlist. Requires runtime approval.",
  "navidrome.playlist.update":
    "Rename, describe, or change songs in a Navidrome playlist. Requires runtime approval.",
  "navidrome.playlist.delete":
    "Delete a Navidrome playlist. Disruptive and requires runtime approval.",
};

export type NavidromeCapabilityMetadata = {
  effect: "read" | "write";
  risk: "low" | "disruptive";
  approval: "none" | "required";
  permission: "read" | "confirm";
};

export const NAVIDROME_CAPABILITY_METADATA: Record<
  NavidromeToolName,
  NavidromeCapabilityMetadata
> = {
  "navidrome.library": {
    effect: "read",
    risk: "low",
    approval: "none",
    permission: "read",
  },
  "navidrome.search": {
    effect: "read",
    risk: "low",
    approval: "none",
    permission: "read",
  },
  "navidrome.artist": {
    effect: "read",
    risk: "low",
    approval: "none",
    permission: "read",
  },
  "navidrome.lyrics": {
    effect: "read",
    risk: "low",
    approval: "none",
    permission: "read",
  },
  "navidrome.queue": {
    effect: "read",
    risk: "low",
    approval: "none",
    permission: "read",
  },
  "navidrome.playlist.create": {
    effect: "write",
    risk: "low",
    approval: "required",
    permission: "confirm",
  },
  "navidrome.playlist.update": {
    effect: "write",
    risk: "low",
    approval: "required",
    permission: "confirm",
  },
  "navidrome.playlist.delete": {
    effect: "write",
    risk: "disruptive",
    approval: "required",
    permission: "confirm",
  },
};

/**
 * Direct capability results retain full provider URLs for the caller.
 * Persisted Artifacts must not keep the reusable Subsonic auth query.
 */
export function redactNavidromeQueueForStorage(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const queue = result as Record<string, unknown>;
  if (!Array.isArray(queue.items)) return result;
  return {
    ...queue,
    items: queue.items.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
      }
      const item = value as Record<string, unknown>;
      return {
        ...item,
        streamUrl: redactSubsonicAuth(item.streamUrl),
        artworkUrl: redactSubsonicAuth(item.artworkUrl),
      };
    }),
  };
}

function redactSubsonicAuth(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith("http")) return value;
  try {
    const url = new URL(value);
    for (const key of ["u", "t", "s"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}
