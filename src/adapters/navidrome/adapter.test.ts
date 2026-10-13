import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NavidromeAdapter } from "./adapter.ts";

const SALT = "0123456789abcdef";
const USERNAME = "listener";
const PASSWORD = "test-password";

function response(body: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ "subsonic-response": { status: "ok", ...body } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(code: number, message: string): Response {
  return new Response(
    JSON.stringify({
      "subsonic-response": {
        status: "failed",
        error: { code, message },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("NavidromeAdapter", () => {
  it("authenticates with Subsonic salt+MD5 and maps library views", async () => {
    const urls: string[] = [];
    const adapter = new NavidromeAdapter({
      baseUrl: "http://navidrome.internal:4533/",
      username: USERNAME,
      password: PASSWORD,
      salt: () => SALT,
      fetch: async (input) => {
        const url = new URL(String(input));
        urls.push(url.toString());
        switch (url.pathname) {
          case "/rest/getAlbumList2.view":
            return response({
              albumList2: {
                album: [
                  {
                    id: "album-1",
                    name: "Quiet Hours",
                    artist: "Night Service",
                    artistId: "artist-1",
                    songCount: 8,
                    year: 2025,
                  },
                ],
              },
            });
          case "/rest/getArtists.view":
            return response({
              artists: {
                index: [
                  {
                    name: "N",
                    artist: [{ id: "artist-1", name: "Night Service", albumCount: 2 }],
                  },
                ],
              },
            });
          case "/rest/getPlaylists.view":
            return response({
              playlists: {
                playlist: [{ id: "playlist-1", name: "Late Shift", songCount: 12 }],
              },
            });
          case "/rest/search3.view":
            return response({
              searchResult3: {
                song: [{ id: "song-1", title: "Afterglow", artist: "Night Service" }],
              },
            });
          default:
            return errorResponse(70, "not found");
        }
      },
    });

    await expect(
      adapter.listLibrary({ mode: "recent", limit: 10, offset: 0 }),
    ).resolves.toEqual({
      mode: "recent",
      albums: [
        {
          id: "album-1",
          name: "Quiet Hours",
          artist: "Night Service",
          artistId: "artist-1",
          songCount: 8,
          year: 2025,
          songs: [],
        },
      ],
    });
    await expect(
      adapter.listLibrary({ mode: "artists", limit: 10, offset: 0 }),
    ).resolves.toEqual({
      mode: "artists",
      artists: [
        {
          id: "artist-1",
          name: "Night Service",
          albumCount: 2,
          albums: [],
        },
      ],
    });
    await expect(
      adapter.listLibrary({ mode: "playlists", limit: 10, offset: 0 }),
    ).resolves.toEqual({
      mode: "playlists",
      playlists: [
        {
          id: "playlist-1",
          name: "Late Shift",
          songCount: 12,
          songs: [],
        },
      ],
    });
    await expect(
      adapter.listLibrary({ mode: "songs", limit: 10, offset: 0 }),
    ).resolves.toEqual({
      mode: "songs",
      songs: [
        {
          id: "song-1",
          title: "Afterglow",
          artist: "Night Service",
        },
      ],
    });

    const token = createHash("md5").update(`${PASSWORD}${SALT}`).digest("hex");
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("u")).toBe(USERNAME);
      expect(parsed.searchParams.get("t")).toBe(token);
      expect(parsed.searchParams.get("s")).toBe(SALT);
      expect(parsed.searchParams.get("v")).toBe("1.16.1");
      expect(parsed.searchParams.get("c")).toBe("Thebe");
      expect(parsed.searchParams.get("f")).toBe("json");
    }
    expect(urls[0]).toContain("type=newest");
  });

  it("maps search, artist details, and structured lyrics", async () => {
    const adapter = new NavidromeAdapter({
      baseUrl: "http://navidrome.internal:4533",
      username: USERNAME,
      password: PASSWORD,
      salt: () => SALT,
      fetch: async (input) => {
        const url = new URL(String(input));
        switch (url.pathname) {
          case "/rest/search3.view":
            return response({
              searchResult3: {
                artist: [{ id: "artist-1", name: "Night Service" }],
                album: [{ id: "album-1", name: "Quiet Hours" }],
                song: [{ id: "song-1", title: "Afterglow" }],
              },
            });
          case "/rest/getArtist.view":
            return response({
              artist: {
                id: "artist-1",
                name: "Night Service",
                albumCount: 2,
                album: [{ id: "album-1", name: "Quiet Hours" }],
              },
            });
          case "/rest/getArtistInfo2.view":
            return response({
              artistInfo2: {
                biography: "Ambient pop from Shanghai.",
                musicBrainzId: "mbid-1",
                similarArtist: [{ id: "artist-2", name: "Blue Terminal" }],
              },
            });
          case "/rest/getLyricsBySongId.view":
            return response({
              lyricsList: {
                structuredLyrics: [
                  {
                    kind: "main",
                    synced: true,
                    offset: 120,
                    line: [
                      { start: 0, value: "First line" },
                      { start: 4200, value: "Second line" },
                    ],
                  },
                ],
              },
            });
          default:
            return errorResponse(70, "not found");
        }
      },
    });

    await expect(adapter.search("night", 5)).resolves.toEqual({
      artists: [{ id: "artist-1", name: "Night Service", albums: [] }],
      albums: [{ id: "album-1", name: "Quiet Hours", songs: [] }],
      songs: [{ id: "song-1", title: "Afterglow" }],
    });
    await expect(adapter.getArtist("artist-1", 5)).resolves.toEqual({
      artist: {
        id: "artist-1",
        name: "Night Service",
        albumCount: 2,
        albums: [{ id: "album-1", name: "Quiet Hours", songs: [] }],
      },
      biography: "Ambient pop from Shanghai.",
      musicBrainzId: "mbid-1",
      similarArtists: [{ id: "artist-2", name: "Blue Terminal", albums: [] }],
    });
    await expect(adapter.getLyrics("song-1")).resolves.toEqual({
      synced: true,
      offsetMilliseconds: 120,
      lines: [
        { startMilliseconds: 0, text: "First line" },
        { startMilliseconds: 4200, text: "Second line" },
      ],
    });
  });

  it("builds direct and transcoded playback queues with artwork and lyrics", async () => {
    const adapter = new NavidromeAdapter({
      baseUrl: "http://navidrome.internal:4533",
      username: USERNAME,
      password: PASSWORD,
      salt: () => SALT,
      fetch: async (input) => {
        const url = new URL(String(input));
        switch (url.pathname) {
          case "/rest/getSong.view":
            return response({
              song: {
                id: url.searchParams.get("id"),
                title: "Afterglow",
                artist: "Night Service",
                artistId: "artist-1",
                album: "Quiet Hours",
                albumId: "album-1",
                coverArt: "cover-1",
                duration: 241,
                year: 2025,
              },
            });
          case "/rest/getLyricsBySongId.view":
            return response({
              lyricsList: {
                structuredLyrics: [
                  {
                    kind: "main",
                    synced: false,
                    line: [{ value: "A lyric" }],
                  },
                ],
              },
            });
          default:
            return errorResponse(70, "not found");
        }
      },
    });

    const direct = await adapter.getPlaybackQueue({
      songIds: ["song-1"],
      mode: "direct",
      includeLyrics: true,
    });
    expect(direct.mode).toBe("direct");
    expect(direct.startIndex).toBe(0);
    expect(direct.items).toHaveLength(1);
    expect(direct.items[0]).toEqual(
      expect.objectContaining({
        queueId: "song-1",
        albumId: "album-1",
        artistId: "artist-1",
        title: "Afterglow",
        artist: "Night Service",
        album: "Quiet Hours",
        duration: 241,
        year: 2025,
        lyrics: {
          synced: false,
          lines: [{ text: "A lyric" }],
        },
      }),
    );
    expect(new URL(direct.items[0]!.streamUrl).searchParams.get("format")).toBe(
      "raw",
    );
    expect(new URL(direct.items[0]!.artworkUrl!).searchParams.get("id")).toBe(
      "cover-1",
    );

    const transcoded = await adapter.getPlaybackQueue({
      songIds: ["song-1"],
      mode: "transcode",
      maxBitRate: 192,
    });
    const stream = new URL(transcoded.items[0]!.streamUrl);
    expect(stream.searchParams.get("maxBitRate")).toBe("192");
    expect(stream.searchParams.has("format")).toBe(false);
    expect(transcoded.maxBitRate).toBe(192);
  });

  it("creates, updates, and deletes playlists with Subsonic parameter names", async () => {
    const calls: URL[] = [];
    const adapter = new NavidromeAdapter({
      baseUrl: "http://navidrome.internal:4533",
      username: USERNAME,
      password: PASSWORD,
      salt: () => SALT,
      fetch: async (input) => {
        const url = new URL(String(input));
        calls.push(url);
        if (url.pathname === "/rest/createPlaylist.view") {
          return response({
            playlist: {
              id: "playlist-1",
              name: url.searchParams.get("name"),
              songCount: 1,
            },
          });
        }
        return response({});
      },
    });

    await expect(
      adapter.createPlaylist({ name: "Late Shift", songIds: ["song-1"] }),
    ).resolves.toEqual({
      id: "playlist-1",
      name: "Late Shift",
      songCount: 1,
      songs: [],
    });
    await adapter.updatePlaylist({
      playlistId: "playlist-1",
      name: "Night Shift",
      isPublic: false,
      addSongIds: ["song-2"],
      removeSongIndexes: [0, 2],
    });
    await adapter.deletePlaylist("playlist-1");

    const create = calls[0]!;
    expect(create.searchParams.getAll("songId")).toEqual(["song-1"]);
    const update = calls[1]!;
    expect(update.searchParams.get("playlistId")).toBe("playlist-1");
    expect(update.searchParams.get("name")).toBe("Night Shift");
    expect(update.searchParams.get("public")).toBe("false");
    expect(update.searchParams.getAll("songIdToAdd")).toEqual(["song-2"]);
    expect(update.searchParams.getAll("songIndexToRemove")).toEqual(["0", "2"]);
    expect(calls[2]!.searchParams.get("id")).toBe("playlist-1");
  });

  it("falls back to the configured alternate URL and maps Subsonic errors", async () => {
    const requested: string[] = [];
    const adapter = new NavidromeAdapter({
      baseUrl: "http://primary.invalid:4533",
      fallbackUrl: "https://music.example.com",
      username: USERNAME,
      password: PASSWORD,
      salt: () => SALT,
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.startsWith("http://primary.invalid")) {
          throw new TypeError("connection refused");
        }
        return response({
          albumList2: { album: [{ id: "album-1", name: "Fallback Album" }] },
        });
      },
    });

    await adapter.listLibrary({ mode: "recent", limit: 1, offset: 0 });
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain("https://music.example.com/rest/getAlbumList2.view");

    const unauthorized = new NavidromeAdapter({
      baseUrl: "http://navidrome.internal:4533",
      username: USERNAME,
      password: PASSWORD,
      fetch: async () => errorResponse(40, "Wrong username or password"),
    });
    await expect(unauthorized.search("x", 1)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Wrong username or password",
    });
  });
});
