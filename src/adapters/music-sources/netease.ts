import type {
  NeteaseProvider,
  NeteaseQuery,
} from "../../agent/capabilities/music-sources.ts";
type Row = Record<string, unknown>;
const TYPES = {
  song: "1",
  album: "10",
  artist: "100",
  playlist: "1000",
} as const;
const rows = (value: unknown): Row[] =>
  Array.isArray(value)
    ? (value.filter((row) => row && typeof row === "object") as Row[])
    : [];
const text = (value: unknown, max = 300) =>
  typeof value === "string" ? value.slice(0, max) : undefined;
const names = (value: unknown) =>
  rows(value)
    .map((row) => text(row.name, 80))
    .filter(Boolean)
    .join(" / ");
export function createNeteaseProvider(
  baseUrl: string,
  request: typeof fetch = fetch
): NeteaseProvider {
  const root = baseUrl.replace(/\/+$/, "");
  async function get(
    path: string,
    query: Record<string, string>
  ): Promise<Row> {
    const response = await request(
      `${root}${path}?${new URLSearchParams(query)}`,
      { signal: AbortSignal.timeout(20_000) }
    );
    if (!response.ok) throw new Error(`NetEase API: HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 5_000_000)
      throw new Error("NetEase API: response exceeds size limit");
    const json = JSON.parse(body) as Row;
    if (json.code !== undefined && json.code !== 200)
      throw new Error(`NetEase API: code ${String(json.code)}`);
    return json;
  }
  return {
    async read(input: NeteaseQuery) {
      const limit = String(
        "limit" in input && input.limit ? Math.min(input.limit, 30) : 10
      );
      switch (input.action) {
        case "search": {
          const kind = input.kind ?? "song";
          const result = ((
            await get("/cloudsearch", {
              keywords: input.query,
              type: TYPES[kind],
              limit,
            })
          ).result ?? {}) as Row;
          const key = {
            song: "songs",
            album: "albums",
            artist: "artists",
            playlist: "playlists",
          }[kind];
          return {
            kind,
            items: rows(result[key]).map((row) => ({
              id: String(row.id),
              name: text(row.name, 120),
              artist:
                names(row.ar ?? row.artists) ||
                text((row.artist as Row | undefined)?.name, 80),
              album: text(
                ((row.al ?? row.album) as Row | undefined)?.name,
                120
              ),
              tracks: row.trackCount,
              durationMs: row.dt,
            })),
          };
        }
        case "lyrics": {
          const json = await get("/lyric", { id: input.id });
          return {
            id: input.id,
            lyrics: text((json.lrc as Row | undefined)?.lyric, 20_000) ?? "",
            translation: text((json.tlyric as Row | undefined)?.lyric, 20_000),
          };
        }
        case "comments": {
          const json = await get("/comment/music", { id: input.id, limit });
          return {
            id: input.id,
            total: json.total,
            hot: rows(json.hotComments)
              .slice(0, Number(limit))
              .map((row) => ({
                user: text((row.user as Row | undefined)?.nickname, 60),
                text: text(row.content, 400),
                likes: row.likedCount,
              })),
          };
        }
        case "playlist": {
          const json = await get("/playlist/track/all", {
            id: input.id,
            limit,
          });
          const detail = ((await get("/playlist/detail", { id: input.id }))
            .playlist ?? {}) as Row;
          return {
            id: input.id,
            name: text(detail.name, 120),
            tracks: rows(json.songs).map((row) => ({
              id: String(row.id),
              name: text(row.name, 120),
              artist: names(row.ar),
            })),
          };
        }
        case "toplist":
          return {
            charts: rows((await get("/toplist", {})).list).map((row) => ({
              id: String(row.id),
              name: text(row.name, 80),
              updated: text(row.updateFrequency, 40),
            })),
          };
      }
    },
  };
}
