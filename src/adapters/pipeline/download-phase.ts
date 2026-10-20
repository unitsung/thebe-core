import type {
  DownloadBadge,
  DownloadCapability,
  DownloadPhase,
} from "../../agent/capabilities/pipeline.ts";

/** Phase, badges and capabilities for one download. The table behind it is `contracts/download-states.json`. */
export type DownloadDescription = {
  phase: DownloadPhase;
  badges: DownloadBadge[];
  capabilities: DownloadCapability[];
};

const sorted = (capabilities: Set<DownloadCapability>) =>
  [...capabilities].sort();

/** qBittorrent's state string (either casing) and progress. */
export function describeTorrent(
  rawState: string,
  progress: number
): DownloadDescription {
  let phase: DownloadPhase;
  const badges: DownloadBadge[] = [];
  switch (rawState.toLowerCase()) {
    case "error":
    case "missingfiles":
      phase = "error";
      break;
    case "pauseddl":
    case "stoppeddl":
      phase = "paused";
      break;
    case "queueddl":
      phase = "queued";
      break;
    case "stalleddl":
      phase = "downloading";
      badges.push("no_progress");
      break;
    case "pausedup":
    case "stoppedup":
      phase = "completed";
      break;
    case "uploading":
    case "forcedup":
    case "stalledup":
    case "queuedup":
      phase = "completed";
      badges.push("seeding");
      break;
    default:
      phase = progress >= 1 ? "completed" : "downloading";
  }
  const capabilities = new Set<DownloadCapability>([
    "remove",
    "remove_with_files",
  ]);
  if (phase === "downloading" || phase === "queued") capabilities.add("pause");
  else if (phase === "paused") capabilities.add("resume");
  else if (phase === "completed")
    capabilities.add(badges.includes("seeding") ? "pause" : "resume");
  return { phase, badges, capabilities: sorted(capabilities) };
}

/**
 * aria2's `status` string. aria2's RPC has no way to delete files; the owner's own `on-download-stop` script
 * does that when an unfinished task is removed, so only an unfinished task offers `remove_with_files`.
 */
export function describeDirect(rawStatus: string): DownloadDescription {
  const capabilities = new Set<DownloadCapability>(["remove"]);
  const badges: DownloadBadge[] = [];
  let phase: DownloadPhase;
  switch (rawStatus) {
    case "active":
      phase = "downloading";
      capabilities.add("pause").add("remove_with_files");
      break;
    case "paused":
      phase = "paused";
      capabilities.add("resume").add("remove_with_files");
      break;
    case "error":
      phase = "error";
      break;
    case "complete":
      phase = "completed";
      break;
    case "removed":
      phase = "completed";
      badges.push("cancelled");
      break;
    default:
      phase = "queued";
      capabilities.add("pause").add("remove_with_files");
  }
  return { phase, badges, capabilities: sorted(capabilities) };
}
