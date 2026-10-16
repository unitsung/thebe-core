import type {
  SqMusicDownload,
  SqMusicProvider,
  SqMusicQuery,
} from "../../agent/capabilities/music-sources.ts";
type Row = Record<string, unknown>;
const list = (value: unknown): Row[] =>
  Array.isArray(value)
    ? (value.filter((row) => row && typeof row === "object") as Row[])
    : [];
const str = (value: unknown) =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
export type SqMusicOptions = {
  baseUrl: string;
  username: string;
  password: string;
};
export function createSqMusicProvider(
  options: SqMusicOptions,
  request: typeof fetch = fetch
): SqMusicProvider {
  const root = options.baseUrl.replace(/\/+$/, "");
  let token: string | undefined;
  async function login(): Promise<string> {
    const response = await request(`${root}/api/config/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: options.username,
        password: options.password,
        device: "web",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json()) as Row;
    const value = str((json.data as Row | undefined)?.tokenValue);
    if (json.code !== 200 || !value)
      throw new Error("SQMusic refused the login");
    return (token = value);
  }
  async function call(
    path: string,
    init: { query?: Record<string, string>; body?: unknown } = {},
    retry = true
  ): Promise<unknown> {
    const url = `${root}${path}${init.query ? `?${new URLSearchParams(init.query)}` : ""}`;
    const response = await request(url, {
      method: init.body ? "POST" : "GET",
      headers: {
        sqmusic: token ?? (await login()),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
    const json = (await response.json()) as Row;
    if (json.code === 200) return json.data;
    if (
      retry &&
      (json.code === 401 || json.code === 40100 || response.status === 401)
    ) {
      token = undefined;
      return call(path, init, false);
    }
    throw new Error(`SQMusic: ${str(json.msg) ?? `code ${str(json.code)}`}`);
  }
  return {
    async download({ plugin, id, query, quality }: SqMusicDownload) {
      // The record must come from SQMusic itself: it is what its download endpoint expects back.
      const page = (await call("/api/music/searchSong", {
        query: {
          plugName: plugin,
          keyword: query,
          pageSize: "30",
          pageIndex: "1",
        },
      })) as Row | undefined;
      const record = list(page?.records).find((row) => str(row.id) === id);
      if (!record)
        throw new Error(
          `SQMusic: song ${id} is not in the first results for "${query}" on ${plugin}; search again with sqmusic_search`
        );
      const offered = Array.isArray(record.brTypes)
        ? record.brTypes.map(String)
        : [];
      if (quality && !offered.includes(quality))
        throw new Error(
          `SQMusic: quality ${quality} is not offered; choose one of ${offered.join(", ") || "(none listed)"}`
        );
      await call("/api/download/downloadSong", {
        body: { ...record, ...(quality ? { brType: quality } : {}) },
      });
      const name = str(record.name);
      const tasks = (await call("/api/task/list", {
        body: { pageSize: 10, pageIndex: 1 },
      })) as Row | undefined;
      const task = list(tasks?.records).find(
        (row) =>
          str(row.downloadMusicname) === name &&
          str(row.downloadPlugName) === plugin
      );
      return {
        queued: true,
        song: name,
        plugin,
        quality: quality ?? offered[0],
        verified: Boolean(task),
        task: task
          ? {
              id: task.id,
              status: str(task.downloadStatus),
              message: str(task.downloadMsg),
            }
          : undefined,
        note: task
          ? undefined
          : "SQMusic accepted the request but the task is not listed yet; check sqmusic_search action tasks.",
      };
    },
    async read(input: SqMusicQuery) {
      switch (input.action) {
        case "plugins":
          return {
            plugins: list(await call("/api/config/getOption")).map((row) => ({
              value: str(row.value),
              label: str(row.label),
              note: str(row.desc),
            })),
          };
        case "search": {
          const page = (await call("/api/music/searchSong", {
            query: {
              plugName: input.plugin,
              keyword: input.query,
              pageSize: String(Math.min(input.limit ?? 10, 30)),
              pageIndex: "1",
            },
          })) as Row | undefined;
          return {
            plugin: input.plugin,
            total: page?.searchTotal ?? page?.total,
            songs: list(page?.records).map((row) => ({
              id: str(row.id),
              name: str(row.name),
              artists: Array.isArray(row.artistName)
                ? row.artistName.map(String)
                : [],
              album: str(row.albumName),
              durationMs: Number(row.duration) || undefined,
              qualities: Array.isArray(row.brTypes)
                ? row.brTypes.map(String)
                : [],
            })),
          };
        }
        case "tasks": {
          const page = (await call("/api/task/list", {
            body: {
              pageSize: Math.min(input.limit ?? 20, 30),
              pageIndex: 1,
              ...(input.status ? { downloadStatus: input.status } : {}),
            },
          })) as Row | undefined;
          return {
            total: page?.total,
            tasks: list(page?.records).map((row) => ({
              id: row.id,
              song: str(row.downloadMusicname),
              artist: str(row.downloadArtistname),
              plugin: str(row.downloadPlugName),
              quality: str(row.downloadBrType),
              status: str(row.downloadStatus),
              message: str(row.downloadMsg),
            })),
          };
        }
      }
    },
  };
}
