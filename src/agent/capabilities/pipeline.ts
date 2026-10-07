/**
 * Media acquisition pipeline: find a release, download it, move it into the
 * library folder and make the media server pick it up and scrape metadata.
 * Providers own credentials and vendor details; the Agent only sees these
 * provider-neutral operations, so a plan can be written once and survives
 * swapping the downloader or the media server.
 */

export type DownloadState = "downloading" | "seeding" | "completed" | "paused" | "queued" | "checking" | "error";

export type DownloadItem = {
  hash: string;
  name: string;
  state: DownloadState;
  /** 0..1 */
  progress: number;
  sizeBytes?: number;
  downloadSpeedBytes?: number;
  etaSeconds?: number;
  category?: string;
  savePath?: string;
  /** Where the finished content is on the downloader's disk. */
  contentPath?: string;
  addedAt?: string;
  completedAt?: string;
};

export interface DownloadProvider {
  readonly service: string;
  add(input: { urls: string[]; savePath?: string; category?: string; paused?: boolean }): Promise<{ submitted: number }>;
  list(input: { filter?: "all" | "downloading" | "completed" | "paused" | "errored"; category?: string; limit?: number }): Promise<DownloadItem[]>;
  get(hash: string): Promise<DownloadItem | undefined>;
}

export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
};

export interface FilesProvider {
  readonly service: string;
  list(input: { path: string; page?: number; perPage?: number }): Promise<{ entries: FileEntry[]; total: number }>;
  mkdir(path: string): Promise<void>;
  copy(input: { sourceDir: string; destinationDir: string; names: string[] }): Promise<{ taskIds: string[] }>;
  move(input: { sourceDir: string; destinationDir: string; names: string[] }): Promise<{ taskIds: string[] }>;
  offlineDownload(input: { urls: string[]; destinationDir: string; tool?: string }): Promise<{ taskIds: string[] }>;
}

export interface LibraryRefreshProvider {
  readonly service: "emby" | "jellyfin";
  /** Ask the server to scan its library folders for new files. */
  scan(): Promise<void>;
  /** Re-scrape metadata and images for one item (and everything under it). */
  refreshItem(input: { id: string; replaceAllMetadata?: boolean; replaceAllImages?: boolean }): Promise<void>;
}

export const PIPELINE_READ_TOOL_NAMES = ["download.list", "download.status", "files.list"] as const;

export const PIPELINE_WRITE_TOOL_NAMES = [
  "download.add",
  "files.mkdir",
  "files.copy",
  "files.move",
  "files.offline_download",
  "library.scan",
  "library.refresh_item",
] as const;

export const PIPELINE_TOOL_NAMES = [...PIPELINE_READ_TOOL_NAMES, ...PIPELINE_WRITE_TOOL_NAMES] as const;
export type PipelineToolName = (typeof PIPELINE_TOOL_NAMES)[number];

const stringArray = (description: string) => ({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 20, description });

export const PIPELINE_TOOL_SCHEMAS: Record<PipelineToolName, Record<string, unknown>> = {
  "download.add": {
    type: "object",
    properties: {
      urls: stringArray("Magnet links or http(s) .torrent URLs. Verify the release with the user first."),
      savePath: { type: "string", description: "Download directory on the downloader host. Omit to use its default." },
      category: { type: "string", description: "Downloader category, e.g. movies or tv." },
      paused: { type: "boolean", description: "Add stopped so the user can review it." },
    },
    required: ["urls"],
  },
  "download.list": {
    type: "object",
    properties: {
      filter: { type: "string", enum: ["all", "downloading", "completed", "paused", "errored"] },
      category: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  "download.status": {
    type: "object",
    properties: { hash: { type: "string", description: "Torrent info-hash from download.list." } },
    required: ["hash"],
  },
  "files.list": {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path in the file manager, e.g. /media/movies." },
      page: { type: "integer", minimum: 1 },
      perPage: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["path"],
  },
  "files.mkdir": {
    type: "object",
    properties: { path: { type: "string", description: "Directory to create (parents are created too)." } },
    required: ["path"],
  },
  "files.copy": {
    type: "object",
    properties: {
      sourceDir: { type: "string" },
      destinationDir: { type: "string" },
      names: stringArray("File or folder names inside sourceDir."),
    },
    required: ["sourceDir", "destinationDir", "names"],
  },
  "files.move": {
    type: "object",
    properties: {
      sourceDir: { type: "string" },
      destinationDir: { type: "string" },
      names: stringArray("File or folder names inside sourceDir."),
    },
    required: ["sourceDir", "destinationDir", "names"],
  },
  "files.offline_download": {
    type: "object",
    properties: {
      urls: stringArray("Direct URLs or magnet links for the file manager's offline downloader."),
      destinationDir: { type: "string" },
      tool: { type: "string", description: "Downloader name configured in the file manager, e.g. qBittorrent, aria2, SimpleHttp." },
    },
    required: ["urls", "destinationDir"],
  },
  "library.scan": {
    type: "object",
    properties: { provider: { type: "string", enum: ["emby", "jellyfin"], description: "Media server. Omit when only one is configured." } },
  },
  "library.refresh_item": {
    type: "object",
    properties: {
      provider: { type: "string", enum: ["emby", "jellyfin"] },
      id: { type: "string", description: "Library item id from emby.search / jellyfin.search." },
      replaceAllMetadata: { type: "boolean", description: "Overwrite existing metadata (scrape again from scratch)." },
      replaceAllImages: { type: "boolean" },
    },
    required: ["id"],
  },
};

export const PIPELINE_TOOL_DESCRIPTIONS: Record<PipelineToolName, string> = {
  "download.add": "Submit magnet or .torrent URLs to the configured downloader. Requires approval. Afterwards poll download.status until it completes; submission is not completion.",
  "download.list": "List downloader tasks with progress and state. Read-only.",
  "download.status": "Get one download by info-hash: progress, state, save path and content path. Read-only.",
  "files.list": "List a directory in the file manager (OpenList). Read-only. Use it to inspect a share or the library folder before copying.",
  "files.mkdir": "Create a directory in the file manager. Requires approval.",
  "files.copy": "Copy files or folders between directories in the file manager (asynchronous task). Requires approval.",
  "files.move": "Move files or folders between directories in the file manager (asynchronous task). Requires approval. Prefer copy until the result is verified.",
  "files.offline_download": "Ask the file manager to download URLs into a directory with its offline downloader (asynchronous task). Requires approval.",
  "library.scan": "Ask Emby or Jellyfin to scan its library folders for new files. Requires approval. Scanning is asynchronous; verify with emby.search / jellyfin.search afterwards.",
  "library.refresh_item": "Re-scrape metadata and images for one library item. Requires approval. Use after files were renamed or identified wrongly.",
};

export type ReleaseCandidate = {
  title: string;
  indexer?: string;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  publishedAt?: string;
  /** magnet: or http(s) .torrent address ready for download.add. */
  downloadUrl: string;
  infoUrl?: string;
  /** Parsed from the title when recognisable. */
  quality?: string;
};

/** Torrent search across the indexers the downloader side already trusts (Prowlarr). */
export interface ReleaseSearchProvider {
  readonly service: string;
  search(input: { query: string; type?: "movie" | "tv" | "music" | "any"; limit?: number }): Promise<ReleaseCandidate[]>;
}

export const RESOURCE_SEARCH_TOOL_NAME = "resource.search" as const;
export const PIPELINE_JOB_TOOL_NAMES = ["pipeline.acquire", "pipeline.advance", "pipeline.status"] as const;
export const PIPELINE_JOB_WRITE_TOOL_NAMES = ["pipeline.acquire"] as const;
