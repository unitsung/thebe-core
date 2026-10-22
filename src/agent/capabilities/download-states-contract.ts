import type {
  DownloadBadge,
  DownloadCapability,
  DownloadPhase,
} from "./pipeline.ts";

/**
 * How each engine's own state becomes the one phase, badges and capabilities every Download carries,
 * exported as data. Core owns the table; a client that reads the engines itself can run the same
 * cases through its own readers, so the two routes cannot disagree about what a stalled or a
 * seeding torrent is.
 */
export const DOWNLOAD_STATES_CONTRACT_PATH = "contracts/download-states.json";

export type DownloadStateCase = {
  /** The engine's own state string, exactly as its API writes it. */
  state: string;
  /** 0..1. qBittorrent's phase for an unlisted state depends on it. */
  progress: number;
  phase: DownloadPhase;
  badges: DownloadBadge[];
  capabilities: DownloadCapability[];
};

const torrent = (
  state: string,
  progress: number,
  phase: DownloadPhase,
  badges: DownloadBadge[],
  extra: "pause" | "resume" | undefined
): DownloadStateCase => ({
  state,
  progress,
  phase,
  badges,
  capabilities: [
    ...(extra === "pause" ? ["pause" as const] : []),
    "remove",
    "remove_with_files",
    ...(extra === "resume" ? ["resume" as const] : []),
  ],
});

/** aria2: only an unfinished task (`extra` set) can be removed with its files, by the owner's own script. */
const direct = (
  state: string,
  progress: number,
  phase: DownloadPhase,
  badges: DownloadBadge[],
  extra: "pause" | "resume" | undefined
): DownloadStateCase => ({
  state,
  progress,
  phase,
  badges,
  capabilities: [
    ...(extra === "pause" ? ["pause" as const] : []),
    "remove",
    ...(extra ? ["remove_with_files" as const] : []),
    ...(extra === "resume" ? ["resume" as const] : []),
  ],
});

export const DOWNLOAD_STATE_CASES = {
  qbittorrent: [
    torrent("downloading", 0.5, "downloading", [], "pause"),
    torrent("forcedDL", 0.5, "downloading", [], "pause"),
    torrent("metaDL", 0, "downloading", [], "pause"),
    torrent("checkingDL", 0.2, "downloading", [], "pause"),
    torrent("stalledDL", 0.4, "downloading", ["no_progress"], "pause"),
    torrent("queuedDL", 0.1, "queued", [], "pause"),
    torrent("pausedDL", 0.3, "paused", [], "resume"),
    torrent("stoppedDL", 0.3, "paused", [], "resume"),
    torrent("uploading", 1, "completed", ["seeding"], "pause"),
    torrent("forcedUP", 1, "completed", ["seeding"], "pause"),
    torrent("stalledUP", 1, "completed", ["seeding"], "pause"),
    torrent("queuedUP", 1, "completed", ["seeding"], "pause"),
    torrent("pausedUP", 1, "completed", [], "resume"),
    torrent("stoppedUP", 1, "completed", [], "resume"),
    torrent("error", 0.3, "error", [], undefined),
    torrent("missingFiles", 0.3, "error", [], undefined),
  ],
  aria2: [
    direct("active", 0.5, "downloading", [], "pause"),
    direct("waiting", 0, "queued", [], "pause"),
    direct("paused", 0.2, "paused", [], "resume"),
    direct("error", 0.2, "error", [], undefined),
    direct("complete", 1, "completed", [], undefined),
    direct("removed", 0.1, "completed", ["cancelled"], undefined),
  ],
} satisfies Record<string, DownloadStateCase[]>;

export function buildDownloadStatesContract() {
  return { version: 1, engines: DOWNLOAD_STATE_CASES };
}
