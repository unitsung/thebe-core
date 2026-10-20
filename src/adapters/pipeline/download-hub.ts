import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  DownloadItem,
  DownloadProvider,
} from "../../agent/capabilities/pipeline.ts";

const TORRENT_ENGINE = "qbittorrent";
const DIRECT_ENGINE = "aria2";
const TORRENT_ID = /^[a-f0-9]{40,64}$/i;
const DIRECT_ID = /^[a-f0-9]{16}$/i;

/** An indexer's own download address (Prowlarr's `/<id>/download?apikey=…&link=…`, Jackett's `/dl/<name>/?jackett_apikey=…`). */
const INDEXER_DOWNLOAD =
  /^https?:\/\/[^?#]*(?:\/(?:\d+\/)?download\/?\?[^#]*\b(?:apikey|link)=|\/dl\/[^/?#]+\/?\?[^#]*\bjackett_apikey=)/i;

/** A magnet, a .torrent file, or an indexer's download address: every one of them is a torrent. */
const isTorrentLink = (url: string) =>
  /^magnet:\?/i.test(url) ||
  /\.torrent(?:[?#].*)?$/i.test(url) ||
  INDEXER_DOWNLOAD.test(url);

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Several download engines behind the one DownloadProvider the tools and acquisition jobs already use.
 * Links go to the engine that suits them (magnets and .torrent files to the torrent engine, everything else
 * to aria2) unless one is named; an id belongs to the engine its shape says (an info-hash or an aria2 gid).
 */
export function createDownloadHub(
  engines: DownloadProvider[]
): DownloadProvider | undefined {
  if (engines.length === 0) return undefined;
  const byName = new Map(engines.map((engine) => [engine.service, engine]));

  const named = (name: string): DownloadProvider => {
    const engine = byName.get(name);
    if (!engine)
      throw new ProviderError("UNKNOWN", `${name} is not configured`);
    return engine;
  };

  const forLink = (url: string): DownloadProvider =>
    byName.get(isTorrentLink(url) ? TORRENT_ENGINE : DIRECT_ENGINE) ??
    engines[0]!;

  const forId = (id: string): DownloadProvider => {
    const value = id.trim();
    if (DIRECT_ID.test(value)) return named(DIRECT_ENGINE);
    if (TORRENT_ID.test(value)) return named(TORRENT_ENGINE);
    throw new ProviderError("UNKNOWN", "Invalid download id");
  };

  /** Runs `act` once per engine on the ids that belong to it. */
  const perEngine = async (
    ids: string[],
    act: (engine: DownloadProvider, ids: string[]) => Promise<void> | undefined
  ) => {
    const groups = new Map<DownloadProvider, string[]>();
    for (const id of ids) {
      const engine = forId(id);
      groups.set(engine, [...(groups.get(engine) ?? []), id]);
    }
    for (const [engine, group] of groups) await act(engine, group);
  };

  const listWithProblems: NonNullable<
    DownloadProvider["listWithProblems"]
  > = async (input) => {
    const chosen = input.engine ? [named(input.engine)] : engines;
    const settled = await Promise.allSettled(
      chosen.map((engine) => engine.list(input))
    );
    const downloads: DownloadItem[] = [];
    const unreachable: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") downloads.push(...result.value);
      else
        unreachable.push(
          `${chosen[index]!.service}: ${messageOf(result.reason)}`
        );
    });
    if (unreachable.length === chosen.length) {
      const first = settled.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      throw first!.reason;
    }
    return { downloads, unreachable };
  };

  const hub: DownloadProvider = {
    service: engines.map((engine) => engine.service).join("+"),

    async add(input) {
      const groups = new Map<DownloadProvider, string[]>();
      for (const url of input.urls) {
        const engine = input.engine ? named(input.engine) : forLink(url.trim());
        groups.set(engine, [...(groups.get(engine) ?? []), url]);
      }
      let submitted = 0;
      for (const [engine, urls] of groups) {
        submitted += (await engine.add({ ...input, urls })).submitted;
      }
      return {
        submitted,
        engine: [...groups.keys()].map((engine) => engine.service).join("+"),
      };
    },

    async list(input) {
      return (await listWithProblems(input)).downloads;
    },

    async get(id) {
      return forId(id).get(id.trim().toLowerCase());
    },
  };

  if (engines.length > 1) hub.listWithProblems = listWithProblems;
  if (engines.some((engine) => engine.pause))
    hub.pause = (ids) =>
      perEngine(
        ids,
        (engine, group) => engine.pause?.(group) ?? unsupported(engine, "pause")
      );
  if (engines.some((engine) => engine.resume))
    hub.resume = (ids) =>
      perEngine(
        ids,
        (engine, group) =>
          engine.resume?.(group) ?? unsupported(engine, "resume")
      );
  if (engines.some((engine) => engine.remove))
    hub.remove = (ids, deleteFiles) =>
      perEngine(
        ids,
        (engine, group) =>
          engine.remove?.(group, deleteFiles) ?? unsupported(engine, "remove")
      );
  return hub;
}

function unsupported(engine: DownloadProvider, action: string): never {
  throw new ProviderError(
    "UNKNOWN",
    `${engine.service} does not support ${action}`
  );
}
