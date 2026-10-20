import type {
  DownloadItem,
  DownloadPhase,
} from "../agent/capabilities/pipeline.ts";

const PHASES: Record<DownloadItem["state"], DownloadPhase> = {
  downloading: "downloading",
  seeding: "completed",
  completed: "completed",
  paused: "paused",
  queued: "queued",
  checking: "downloading",
  error: "error",
};

/** A DownloadItem for tests: only what a test cares about is given, the rest follows from the state. */
export function downloadItem(
  item: Pick<DownloadItem, "hash" | "name" | "state" | "progress"> &
    Partial<DownloadItem>
): DownloadItem {
  return {
    engine: "qbittorrent",
    id: item.hash,
    phase: PHASES[item.state],
    badges: item.state === "seeding" ? ["seeding"] : [],
    capabilities: [],
    ...item,
  };
}
