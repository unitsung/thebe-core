import type { DownloadEngine } from "../../agent/capabilities/pipeline.ts";

/** The torrent engine, and the engine for every other link. Each is the `service` of its adapter. */
export const TORRENT_ENGINE = "qbittorrent" satisfies DownloadEngine;
export const DIRECT_ENGINE = "aria2" satisfies DownloadEngine;

/** An engine's own id for a download: a torrent info-hash, or an aria2 gid. The shapes cannot be confused. */
export const TORRENT_ID = /^[a-f0-9]{40,64}$/i;
export const DIRECT_ID = /^[a-f0-9]{16}$/i;
