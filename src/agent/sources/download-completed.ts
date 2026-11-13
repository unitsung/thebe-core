import type {
  DownloadItem,
  DownloadProvider,
} from "../capabilities/pipeline.ts";
import { key } from "../tickets/ids.ts";
import type { Source, Trigger } from "./types.ts";

export const DOWNLOAD_COMPLETED_SOURCE_ID = "download-completed";

/** Keeps a requested Source visible in health instead of silently omitting a missing provider. */
export function createUnconfiguredDownloadCompletedSource(): Source {
  return {
    id: DOWNLOAD_COMPLETED_SOURCE_ID,
    scope: "Configured download engines (read-only)",
    async read() {
      throw new Error("No download provider is configured");
    },
  };
}

type ItemState = {
  phase: DownloadItem["phase"];
  completedAt?: string;
};

type Cursor = {
  n: number;
  items: Record<string, ItemState>;
};

/**
 * Reports a download entering its completed phase. The first read is a baseline, so starting Core does
 * not replay every old download. The cursor keeps the previous phase per engine/hash, which lets one
 * deterministic Source produce `download.completed` once and preserve it across restarts.
 */
export function createDownloadCompletedSource(options: {
  downloads: DownloadProvider;
  now: () => Date;
}): Source {
  return {
    id: DOWNLOAD_COMPLETED_SOURCE_ID,
    scope: "Configured download engines (read-only)",
    async read(rawCursor) {
      const listing = await readAll(options.downloads);
      if (listing.unreachable.length > 0) {
        throw new Error(
          `partial download listing: ${listing.unreachable.join("; ")}`
        );
      }
      const current = indexDownloads(listing.downloads);
      const previous = parseCursor(rawCursor);
      if (!previous) {
        return {
          triggers: [],
          cursor: JSON.stringify({ n: 0, items: current }),
        };
      }

      const n = previous.n + 1;
      const at = options.now().toISOString();
      const triggers: Trigger[] = [];
      for (const [downloadKey, item] of Object.entries(
        indexDownloadItems(listing.downloads)
      )) {
        const before = previous.items[downloadKey]?.phase;
        if (before === "completed" || item.phase !== "completed") continue;
        const completedAt = item.completedAt ?? at;
        triggers.push({
          // The read's sequence number keeps a crash-before-cursor replay idempotent. The completion
          // time is not part of the id: a provider that reports no completion time (aria2) would
          // otherwise hash the read clock and turn one replay into a second Trigger.
          id: key(
            "trigger",
            DOWNLOAD_COMPLETED_SOURCE_ID,
            item.engine,
            item.hash,
            before ?? "-",
            "completed",
            String(n)
          ),
          source: DOWNLOAD_COMPLETED_SOURCE_ID,
          kind: "download.completed",
          at: completedAt,
          threads: [`resource:download:${item.engine}:${item.hash}`],
          resource: { kind: "download", id: `${item.engine}:${item.hash}` },
          payload: {
            engine: item.engine,
            hash: item.hash,
            name: item.name,
            from: before ?? null,
            to: "completed",
            ...(item.sizeBytes !== undefined
              ? { sizeBytes: item.sizeBytes }
              : {}),
            ...(item.contentPath ? { contentPath: item.contentPath } : {}),
            ...(item.category ? { category: item.category } : {}),
          },
        });
      }
      return {
        triggers,
        cursor: JSON.stringify({ n, items: current }),
      };
    },
  };
}

async function readAll(
  downloads: DownloadProvider
): Promise<{ downloads: DownloadItem[]; unreachable: string[] }> {
  if (downloads.listWithProblems) {
    return downloads.listWithProblems({ filter: "all", limit: 100 });
  }
  return {
    downloads: await downloads.list({ filter: "all", limit: 100 }),
    unreachable: [],
  };
}

function indexDownloads(
  items: readonly DownloadItem[]
): Record<string, ItemState> {
  const out: Record<string, ItemState> = {};
  for (const item of items) {
    out[itemKey(item)] = {
      phase: item.phase,
      ...(item.completedAt ? { completedAt: item.completedAt } : {}),
    };
  }
  return out;
}

function indexDownloadItems(
  items: readonly DownloadItem[]
): Record<string, DownloadItem> {
  return Object.fromEntries(items.map((item) => [itemKey(item), item]));
}

function itemKey(item: DownloadItem): string {
  return `${item.engine}:${item.hash}`;
}

function parseCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { n?: unknown; items?: unknown };
    if (
      typeof parsed.n === "number" &&
      Number.isInteger(parsed.n) &&
      parsed.items &&
      typeof parsed.items === "object" &&
      !Array.isArray(parsed.items)
    ) {
      return {
        n: parsed.n,
        items: parsed.items as Record<string, ItemState>,
      };
    }
  } catch {
    // A new baseline is safer than announcing every completed item as new.
  }
  return undefined;
}
