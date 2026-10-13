import { createHash, randomBytes } from "node:crypto";
import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  NavidromeAlbum,
  NavidromeAlbumListType,
  NavidromeArtist,
  NavidromeArtistDetails,
  NavidromeCreatePlaylistInput,
  NavidromeLibraryInput,
  NavidromeLibraryResult,
  NavidromeLyrics,
  NavidromePlaylist,
  NavidromeProvider,
  NavidromeQueue,
  NavidromeQueueInput,
  NavidromeSearchResult,
  NavidromeSong,
  NavidromeUpdatePlaylistInput,
} from "../../agent/capabilities/navidrome.ts";

const SUBSONIC_API_VERSION = "1.16.1";
const SUBSONIC_CLIENT_NAME = "Thebe";
const DEFAULT_LIMIT = 30;
const DEFAULT_TRANSCODE_BIT_RATE = 320;
const MAX_QUEUE_ITEMS = 500;

export type NavidromeAdapterOptions = {
  baseUrl: string;
  username: string;
  password: string;
  fallbackUrl?: string;
  fetch?: typeof fetch;
  salt?: () => string;
};

type Json = Record<string, unknown>;

export class NavidromeAdapter implements NavidromeProvider {
  readonly service = "navidrome";

  private readonly baseUrl: string;
  private readonly fallbackUrl?: string;
  private readonly username: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly salt: () => string;
  private activeBaseUrl: string;

  constructor(options: NavidromeAdapterOptions) {
    this.baseUrl = cleanBaseUrl(options.baseUrl);
    this.fallbackUrl = options.fallbackUrl
      ? cleanBaseUrl(options.fallbackUrl)
      : undefined;
    this.username = options.username.trim();
    this.password = options.password;
    this.fetchImpl = options.fetch ?? fetch;
    this.salt = options.salt ?? (() => randomBytes(16).toString("hex"));
    this.activeBaseUrl = this.baseUrl;
  }

  async listLibrary(
    input: NavidromeLibraryInput
  ): Promise<NavidromeLibraryResult> {
    const limit = clampInteger(input.limit, 1, 100, DEFAULT_LIMIT);
    const offset = clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    if (input.mode === "artists") {
      const artists = await this.listArtists();
      return {
        mode: "artists",
        artists: artists.slice(offset, offset + limit),
      };
    }
    if (input.mode === "playlists") {
      const playlists = await this.listPlaylists();
      return {
        mode: "playlists",
        playlists: playlists.slice(offset, offset + limit),
      };
    }
    if (input.mode === "songs") {
      return { mode: "songs", songs: await this.listSongs(offset, limit) };
    }

    const type = albumListType(input.mode);
    return {
      mode: input.mode,
      albums: await this.listAlbums(type, limit, offset),
    };
  }

  async search(query: string, limit: number): Promise<NavidromeSearchResult> {
    const count = clampInteger(limit, 1, 60, 20);
    const response = await this.requestJson("/rest/search3.view", {
      query,
      artistCount: String(count),
      albumCount: String(count),
      songCount: String(count),
    });
    const result = asObject(response.searchResult3);
    return {
      artists: asArray(result.artist).map(mapArtist).filter(isArtist),
      albums: asArray(result.album).map(mapAlbum).filter(isAlbum),
      songs: asArray(result.song).map(mapSong).filter(isSong),
    };
  }

  async getArtist(
    id: string,
    limit = 12
  ): Promise<NavidromeArtistDetails | undefined> {
    const artistResponse = await this.requestJson("/rest/getArtist.view", {
      id,
    });
    const artist = mapArtist(asObject(artistResponse.artist));
    if (!isArtist(artist)) return undefined;

    let info: Json = {};
    try {
      const infoResponse = await this.requestJson("/rest/getArtistInfo2.view", {
        id,
        count: String(clampInteger(limit, 1, 50, 12)),
      });
      info = asObject(infoResponse.artistInfo2);
    } catch {
      // Artist metadata is optional; Navidrome may not have an external provider.
    }

    return {
      artist,
      biography: nonEmptyString(info.biography),
      musicBrainzId: nonEmptyString(info.musicBrainzId),
      lastFmUrl: nonEmptyString(info.lastFmUrl),
      smallImageUrl: nonEmptyString(info.smallImageUrl),
      mediumImageUrl: nonEmptyString(info.mediumImageUrl),
      largeImageUrl: nonEmptyString(info.largeImageUrl),
      similarArtists: asArray(info.similarArtist)
        .map(mapArtist)
        .filter(isArtist),
    };
  }

  async getLyrics(songId: string): Promise<NavidromeLyrics | undefined> {
    try {
      const response = await this.requestJson("/rest/getLyricsBySongId.view", {
        id: songId,
      });
      const tracks = asArray(asObject(response.lyricsList).structuredLyrics);
      const track =
        tracks
          .map(asObject)
          .find((item) => stringField(item, "kind") === "main") ??
        asObject(tracks[0]);
      const lines = asArray(track.line)
        .map((line) => {
          const item = asObject(line);
          return {
            startMilliseconds: numberField(item, "start"),
            text: stringField(item, "value"),
          };
        })
        .filter((line) => line.text.length > 0);
      if (lines.length > 0) {
        return {
          synced:
            booleanField(track, "synced") === true &&
            lines.some((line) => line.startMilliseconds !== undefined),
          offsetMilliseconds: numberField(track, "offset"),
          lines,
        };
      }
    } catch {
      // Fall back to the legacy lyrics endpoint below.
    }

    const song = await this.getSong(songId);
    if (!song) return undefined;
    const response = await this.requestJson("/rest/getLyrics.view", {
      artist: song.artist ?? "",
      title: song.title,
    });
    const value = stringField(asObject(response.lyrics), "value").trim();
    if (!value) return undefined;
    return {
      synced: false,
      lines: value
        .split(/\r?\n/)
        .map((text) => text.trim())
        .filter((text) => text.length > 0)
        .map((text) => ({ text })),
    };
  }

  async getPlaybackQueue(input: NavidromeQueueInput): Promise<NavidromeQueue> {
    const songs = await this.resolveQueueSongs(input);
    if (songs.length === 0) {
      throw new ProviderError(
        "NOT_FOUND",
        "Navidrome did not return any songs for the queue"
      );
    }

    const mode = input.mode ?? "direct";
    const maxBitRate =
      mode === "transcode"
        ? normalizeBitRate(input.maxBitRate ?? DEFAULT_TRANSCODE_BIT_RATE)
        : undefined;
    const limit = clampInteger(input.limit, 1, MAX_QUEUE_ITEMS, songs.length);
    const selected = songs.slice(0, limit);
    const authorization = this.authorizationItems();
    const lyrics = input.includeLyrics
      ? await Promise.all(
          selected.map((song) => this.getLyrics(song.id).catch(() => undefined))
        )
      : [];

    const items = selected.map((song, index) => {
      const streamItems: Array<[string, string]> = [
        ["id", song.id],
        mode === "direct"
          ? ["format", "raw"]
          : ["maxBitRate", String(maxBitRate)],
      ];
      const artworkId = song.coverArt ?? song.albumId;
      return {
        queueId: song.id,
        streamUrl: this.buildUrl(this.activeBaseUrl, "/rest/stream.view", [
          ...authorization,
          ...streamItems,
        ]),
        requestHeaders: {},
        title: song.title,
        artist: song.artist ?? "",
        album: song.album ?? "",
        artworkUrl: artworkId
          ? this.buildUrl(this.activeBaseUrl, "/rest/getCoverArt.view", [
              ...authorization,
              ["id", artworkId],
              ["size", "600"],
            ])
          : undefined,
        artworkHeaders: {},
        lyrics: lyrics[index],
        duration: song.duration,
        year: song.year,
        albumId: song.albumId,
        artistId: song.artistId,
      };
    });

    return {
      items,
      startIndex: clampInteger(input.startIndex ?? 0, 0, items.length - 1, 0),
      mode,
      maxBitRate,
    };
  }

  async createPlaylist(
    input: NavidromeCreatePlaylistInput
  ): Promise<NavidromePlaylist | undefined> {
    const params = new URLSearchParams({ name: input.name });
    for (const songId of input.songIds ?? []) {
      params.append("songId", songId);
    }
    const response = await this.requestJson(
      "/rest/createPlaylist.view",
      params
    );
    const playlist = mapPlaylist(asObject(response.playlist));
    return isPlaylist(playlist) ? playlist : undefined;
  }

  async updatePlaylist(input: NavidromeUpdatePlaylistInput): Promise<void> {
    const params = new URLSearchParams({ playlistId: input.playlistId });
    if (input.name !== undefined) params.set("name", input.name);
    if (input.comment !== undefined) params.set("comment", input.comment);
    if (input.isPublic !== undefined) {
      params.set("public", input.isPublic ? "true" : "false");
    }
    for (const songId of input.addSongIds ?? []) {
      params.append("songIdToAdd", songId);
    }
    for (const index of input.removeSongIndexes ?? []) {
      params.append("songIndexToRemove", String(index));
    }
    await this.requestJson("/rest/updatePlaylist.view", params);
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.requestJson("/rest/deletePlaylist.view", { id });
  }

  private async listAlbums(
    type: NavidromeAlbumListType,
    size: number,
    offset: number
  ): Promise<NavidromeAlbum[]> {
    const response = await this.requestJson("/rest/getAlbumList2.view", {
      type,
      size: String(size),
      offset: String(offset),
    });
    return asArray(asObject(response.albumList2).album)
      .map(mapAlbum)
      .filter(isAlbum);
  }

  private async getAlbum(id: string): Promise<NavidromeAlbum | undefined> {
    const response = await this.requestJson("/rest/getAlbum.view", { id });
    const album = mapAlbum(asObject(response.album));
    return isAlbum(album) ? album : undefined;
  }

  private async getSong(id: string): Promise<NavidromeSong | undefined> {
    const response = await this.requestJson("/rest/getSong.view", { id });
    const song = mapSong(asObject(response.song));
    return isSong(song) ? song : undefined;
  }

  private async listArtists(): Promise<NavidromeArtist[]> {
    const response = await this.requestJson("/rest/getArtists.view");
    const indexes = asArray(asObject(response.artists).index);
    return indexes
      .flatMap((index) => asArray(asObject(index).artist))
      .map(mapArtist)
      .filter(isArtist);
  }

  private async listSongs(
    offset: number,
    limit: number
  ): Promise<NavidromeSong[]> {
    const response = await this.requestJson("/rest/search3.view", {
      query: "",
      artistCount: "0",
      albumCount: "0",
      songCount: String(limit),
      songOffset: String(offset),
    });
    return asArray(asObject(response.searchResult3).song)
      .map(mapSong)
      .filter(isSong);
  }

  private async listPlaylists(): Promise<NavidromePlaylist[]> {
    const response = await this.requestJson("/rest/getPlaylists.view");
    return asArray(asObject(response.playlists).playlist)
      .map(mapPlaylist)
      .filter(isPlaylist);
  }

  private async getPlaylist(
    id: string
  ): Promise<NavidromePlaylist | undefined> {
    const response = await this.requestJson("/rest/getPlaylist.view", { id });
    const playlist = mapPlaylist(asObject(response.playlist));
    return isPlaylist(playlist) ? playlist : undefined;
  }

  private async resolveQueueSongs(
    input: NavidromeQueueInput
  ): Promise<NavidromeSong[]> {
    if (input.playlistId) {
      const playlist = await this.getPlaylist(input.playlistId);
      return playlist?.songs ?? [];
    }
    if (input.albumId) {
      const album = await this.getAlbum(input.albumId);
      return album?.songs ?? [];
    }
    const ids = [...new Set(input.songIds ?? [])].filter((id) => id.length > 0);
    if (ids.length === 0) {
      throw new ProviderError(
        "UNKNOWN",
        "Navidrome queue requires songIds, albumId, or playlistId"
      );
    }
    const songs = await Promise.all(ids.map((id) => this.getSong(id)));
    return songs.filter((song): song is NavidromeSong => song !== undefined);
  }

  private async requestJson(
    path: string,
    extraItems: URLSearchParams | Record<string, string> = {}
  ): Promise<Json> {
    const bases = [this.baseUrl, this.fallbackUrl].filter(
      (value, index, all): value is string =>
        Boolean(value) && all.indexOf(value) === index
    );
    let lastError: unknown;

    for (const baseUrl of bases) {
      let response: Response;
      try {
        response = await this.fetchImpl(
          this.buildUrl(baseUrl, path, [
            ...this.authorizationItems(),
            ...asEntries(extraItems),
          ]),
          {
            method: "GET",
            headers: { Accept: "application/json" },
          }
        );
      } catch (cause) {
        lastError = new ProviderError(
          "UNREACHABLE",
          "Navidrome is unreachable",
          cause
        );
        continue;
      }

      if (!response.ok) {
        const error = new ProviderError(
          response.status === 401 || response.status === 403
            ? "UNAUTHORIZED"
            : response.status === 404
              ? "NOT_FOUND"
              : "UNKNOWN",
          `Navidrome HTTP ${response.status}`
        );
        if (response.status >= 500 && bases.length > 1) {
          lastError = error;
          continue;
        }
        throw error;
      }

      const payload = (await response.json()) as unknown;
      const subsonic = asObject(asObject(payload)["subsonic-response"]);
      const status = stringField(subsonic, "status").toLowerCase();
      if (status !== "ok") {
        throw subsonicError(asObject(subsonic.error));
      }
      this.activeBaseUrl = baseUrl;
      return subsonic;
    }

    throw lastError instanceof Error
      ? lastError
      : new ProviderError("UNREACHABLE", "Navidrome is unreachable");
  }

  private authorizationItems(): Array<[string, string]> {
    const salt = this.salt();
    return [
      ["u", this.username],
      ["t", createHash("md5").update(`${this.password}${salt}`).digest("hex")],
      ["s", salt],
      ["v", SUBSONIC_API_VERSION],
      ["c", SUBSONIC_CLIENT_NAME],
      ["f", "json"],
    ];
  }

  private buildUrl(
    baseUrl: string,
    path: string,
    items: Array<[string, string]>
  ): string {
    const params = new URLSearchParams();
    for (const [key, value] of items) {
      params.append(key, value);
    }
    return `${baseUrl}${path}?${params.toString()}`;
  }
}

function albumListType(
  mode: NavidromeLibraryInput["mode"]
): NavidromeAlbumListType {
  switch (mode) {
    case "recent":
      return "newest";
    case "recently_played":
      return "recent";
    case "albums":
      return "alphabeticalByName";
    case "recommended":
      return "random";
    case "random":
    case "frequent":
    case "highest":
    case "starred":
      return mode;
    default:
      return "newest";
  }
}

function mapAlbum(value: unknown): NavidromeAlbum {
  const album = asObject(value);
  return {
    id: stringField(album, "id"),
    name:
      stringField(album, "name") ||
      stringField(album, "album") ||
      stringField(album, "title"),
    artist: nonEmptyString(album.artist),
    artistId: nonEmptyString(album.artistId),
    coverArt: nonEmptyString(album.coverArt),
    songCount: numberField(album, "songCount"),
    duration: numberField(album, "duration"),
    year: numberField(album, "year"),
    genre: nonEmptyString(album.genre),
    created: nonEmptyString(album.created),
    songs: asArray(album.song).map(mapSong).filter(isSong),
  };
}

function mapSong(value: unknown): NavidromeSong {
  const song = asObject(value);
  return {
    id: stringField(song, "id"),
    title: stringField(song, "title"),
    artist: nonEmptyString(song.artist),
    artistId: nonEmptyString(song.artistId),
    album: nonEmptyString(song.album),
    albumId: nonEmptyString(song.albumId),
    coverArt: nonEmptyString(song.coverArt),
    duration: numberField(song, "duration"),
    track: numberField(song, "track"),
    discNumber: numberField(song, "discNumber"),
    year: numberField(song, "year"),
    suffix: nonEmptyString(song.suffix),
    contentType: nonEmptyString(song.contentType),
    bitRate: numberField(song, "bitRate"),
    bitDepth: numberField(song, "bitDepth"),
    samplingRate: numberField(song, "samplingRate"),
    channelCount: numberField(song, "channelCount"),
    size: numberField(song, "size"),
  };
}

function mapArtist(value: unknown): NavidromeArtist {
  const artist = asObject(value);
  return {
    id: stringField(artist, "id"),
    name: stringField(artist, "name"),
    coverArt: nonEmptyString(artist.coverArt),
    albumCount: numberField(artist, "albumCount"),
    albums: asArray(artist.album).map(mapAlbum).filter(isAlbum),
  };
}

function mapPlaylist(value: unknown): NavidromePlaylist {
  const playlist = asObject(value);
  return {
    id: stringField(playlist, "id"),
    name: stringField(playlist, "name"),
    comment: nonEmptyString(playlist.comment),
    owner: nonEmptyString(playlist.owner),
    isPublic: booleanField(playlist, "public"),
    songCount: numberField(playlist, "songCount"),
    duration: numberField(playlist, "duration"),
    coverArt: nonEmptyString(playlist.coverArt),
    created: nonEmptyString(playlist.created),
    changed: nonEmptyString(playlist.changed),
    songs: asArray(playlist.entry).map(mapSong).filter(isSong),
  };
}

function isAlbum(value: NavidromeAlbum): boolean {
  return Boolean(value.id && value.name);
}

function isSong(value: NavidromeSong): boolean {
  return Boolean(value.id && value.title);
}

function isArtist(value: NavidromeArtist): boolean {
  return Boolean(value.id && value.name);
}

function isPlaylist(value: NavidromePlaylist): boolean {
  return Boolean(value.id && value.name);
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function stringField(object: Json, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value : "";
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberField(object: Json, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanField(object: Json, key: string): boolean | undefined {
  const value = object[key];
  return typeof value === "boolean" ? value : undefined;
}

function asEntries(
  value: URLSearchParams | Record<string, string>
): Array<[string, string]> {
  return value instanceof URLSearchParams
    ? [...value.entries()]
    : Object.entries(value);
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeBitRate(value: number): number {
  const allowed = [64, 128, 192, 256, 320];
  return allowed.includes(value) ? value : DEFAULT_TRANSCODE_BIT_RATE;
}

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function subsonicError(error: Json): ProviderError {
  const code = numberField(error, "code");
  const message =
    nonEmptyString(error.message) ?? `Navidrome error ${code ?? "unknown"}`;
  if (code !== undefined && [40, 41, 42, 43, 44, 50].includes(code)) {
    return new ProviderError("UNAUTHORIZED", message);
  }
  if (code === 70) {
    return new ProviderError("NOT_FOUND", message);
  }
  return new ProviderError("UNKNOWN", message);
}
