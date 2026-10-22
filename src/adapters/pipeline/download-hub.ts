import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  DownloadItem,
  DownloadProvider,
} from "../../agent/capabilities/pipeline.ts";
import {
  DIRECT_ENGINE,
  DIRECT_ID,
  TORRENT_ENGINE,
  TORRENT_ID,
} from "./download-engines.ts";

export type DownloadHubOptions = {
  /**
   * Whether an address is served by the indexer manager that searched for it. Such an address ends in no
   * `.torrent` but fetches one, so it belongs to the torrent engine like a magnet link.
   */
  isIndexerAddress?: (url: string) => boolean;
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Several download engines behind the one DownloadProvider the tools and acquisition jobs already use.
 * Links go to the engine that suits them (magnets and .torrent files to the torrent engine, everything else
 * to aria2) unless one is named; an id belongs to the engine its shape says (an info-hash or an aria2 gid).
 */
export function createDownloadHub(
  engines: DownloadProvider[],
  options: DownloadHubOptions = {}
): DownloadProvider | undefined {
  if (engines.length === 0) return undefined;
  const byName = new Map(engines.map((engine) => [engine.service, engine]));

  const named = (name: string): DownloadProvider => {
    const engine = byName.get(name);
    if (!engine)
      throw new ProviderError("UNKNOWN", `${name} is not configured`);
    return engine;
  };

  /** A magnet, a .torrent file, or an address the indexer manager serves: every one of them is a torrent. */
  const isTorrentLink = (url: string) =>
    /^magnet:\?/i.test(url) ||
    /\.torrent(?:[?#].*)?$/i.test(url) ||
    options.isIndexerAddress?.(url) === true;

  const forLink = (url: string): DownloadProvider =>
    byName.get(isTorrentLink(url) ? TORRENT_ENGINE : DIRECT_ENGINE) ??
    engines[0]!;

  const forId = (id: string): DownloadProvider => {
    const value = id.trim();
    if (DIRECT_ID.test(value)) return named(DIRECT_ENGINE);
    if (TORRENT_ID.test(value)) return named(TORRENT_ENGINE);
    throw new ProviderError("UNKNOWN", "Invalid download id");
  };

  /** Items grouped by the engine that owns them, in the order the engines first appear. */
  const byEngine = (
    items: string[],
    engineOf: (item: string) => DownloadProvider
  ) => {
    const groups = new Map<DownloadProvider, string[]>();
    for (const item of items) {
      const engine = engineOf(item);
      groups.set(engine, [...(groups.get(engine) ?? []), item]);
    }
    return groups;
  };

  /**
   * Runs `act` once per engine on the ids that belong to it. An engine that fails does not stop the others,
   * and the error says which engines did the work, so a half-done batch is never reported as plain failure.
   */
  const perEngine = async (
    ids: string[],
    act: (engine: DownloadProvider, ids: string[]) => Promise<void> | undefined
  ) => {
    const groups = byEngine(ids, forId);
    const failed: string[] = [];
    const done: string[] = [];
    for (const [engine, group] of groups) {
      try {
        await act(engine, group);
        done.push(engine.service);
      } catch (error) {
        failed.push(`${engine.service}: ${messageOf(error)}`);
      }
    }
    if (failed.length === 0) return;
    throw new ProviderError(
      "UNKNOWN",
      done.length > 0
        ? `${failed.join("; ")} (already done on ${done.join(", ")})`
        : failed.join("; ")
    );
  };

  const listWithProblems: NonNullable<
    DownloadProvider["listWithProblems"]
  > = async (input) => {
    const chosen = input.engine ? [named(input.engine)] : engines;
    const settled = await Promise.allSettled(
      chosen.map((engine) => engine.list(input))
    );
    const answers: DownloadItem[][] = [];
    const unreachable: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") answers.push(result.value);
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
    return {
      downloads: interleave(answers).slice(0, listLimit(input.limit)),
      unreachable,
    };
  };

  const hub: DownloadProvider = {
    service: engines.map((engine) => engine.service).join("+"),

    async add(input) {
      const groups = byEngine(input.urls, (url) =>
        input.engine ? named(input.engine) : forLink(url.trim())
      );
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
  /** Pause and resume differ only in the verb; a verb no engine has is not offered at all. */
  const control = (verb: "pause" | "resume") =>
    engines.some((engine) => engine[verb])
      ? (ids: string[]) =>
          perEngine(
            ids,
            (engine, group) =>
              engine[verb]?.(group) ?? unsupported(engine, verb)
          )
      : undefined;
  hub.pause = control("pause");
  hub.resume = control("resume");
  if (engines.some((engine) => engine.remove))
    hub.remove = (ids, deleteFiles) =>
      perEngine(
        ids,
        (engine, group) =>
          engine.remove?.(group, deleteFiles) ?? unsupported(engine, "remove")
      );
  return hub;
}

const listLimit = (limit?: number) => Math.min(Math.max(limit ?? 30, 1), 100);

/** One row from each engine in turn, so a busy engine cannot push the others out of a limited list. */
function interleave<T>(lists: T[][]): T[] {
  const merged: T[] = [];
  for (let index = 0; lists.some((list) => index < list.length); index++)
    for (const list of lists)
      if (index < list.length) merged.push(list[index]!);
  return merged;
}

function unsupported(engine: DownloadProvider, action: string): never {
  throw new ProviderError(
    "UNKNOWN",
    `${engine.service} does not support ${action}`
  );
}
