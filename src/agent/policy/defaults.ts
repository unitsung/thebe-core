import type { PolicyDefaultSet } from "./types.ts";

type DefaultSetDefinition = Omit<PolicyDefaultSet, "enabled">;

/**
 * Rules for common homelab situations. They are switched on and off as a set and are only
 * guidance for the Assessment: what a task may touch is decided by its mandate, not by these words.
 */
export const DEFAULT_RULE_SETS: readonly DefaultSetDefinition[] = [
  {
    id: "containers",
    title: "Containers",
    description: "Crashed, unhealthy or broken containers.",
    rules: [
      {
        id: "containers/crashed",
        name: "Container keeps exiting",
        text: "When a container exits or restarts without being stopped by a person, look at its exit code, recent logs and restart count. Restart it if it is on the allowed list, and stop and ask me if it has been restarted more than three times in an hour.",
      },
      {
        id: "containers/unhealthy",
        name: "Container is unhealthy",
        text: "When a container's health check keeps failing but it has not exited, diagnose it with read-only checks and tell me what looks wrong. Only restart it if it is on the allowed list.",
      },
      {
        id: "containers/after-update",
        name: "Container broke after an image update",
        text: "When a container fails within 30 minutes of an image change, say that the update is the likely cause and name the previous image tag. Do not roll back a container that is not on the allowed list.",
      },
    ],
  },
  {
    id: "downloads",
    title: "Downloads",
    description: "Stalled and failed downloads.",
    rules: [
      {
        id: "downloads/stalled",
        name: "Download is stuck",
        text: "When a download has made no progress for a long time, check its state in the download engine and report why it is stuck. Pause or re-announce it if that is safe, and never delete it.",
      },
      {
        id: "downloads/failed",
        name: "Download failed",
        text: "When a download fails or fails verification, find the reason and tell me. Retry it once if the cause looks temporary. Never delete downloaded files.",
      },
    ],
  },
  {
    id: "media-library",
    title: "Media library",
    description: "Library scans and playback problems.",
    rules: [
      {
        id: "media-library/scan-stuck",
        name: "Library scan is stuck",
        text: "When a media library scan has not finished after an unusually long time, check the media server's state and tell me what is blocking it. Do not remove anything from the library.",
      },
    ],
  },
  {
    id: "storage",
    title: "Storage",
    description: "Disks and volumes running out of space.",
    rules: [
      {
        id: "storage/nearly-full",
        name: "Storage is nearly full",
        text: "When a volume is more than 90% full, find what takes the most space and suggest what could be cleaned up. Deleting is irreversible, so only suggest it and leave the choice to me.",
      },
    ],
  },
];
