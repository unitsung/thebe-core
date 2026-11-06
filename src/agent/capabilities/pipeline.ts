/**
 * Media acquisition pipeline: find a release, download it, move it into the
 * library folder and make the media server pick it up and scrape metadata.
 * Providers own credentials and vendor details; the Agent only sees these
 * provider-neutral operations, so a plan can be written once and survives
 * swapping the downloader or the media server.
 */

export type DownloadState =
  | "downloading"
  | "seeding"
  | "completed"
  | "paused"
  | "queued"
  | "checking"
  | "error";

/** The download engines Core can drive. */
export const DOWNLOAD_ENGINES = ["qbittorrent", "aria2"] as const;
export type DownloadEngine = (typeof DOWNLOAD_ENGINES)[number];

/** Where a download stands, in one vocabulary for every engine (clients use the same one). */
export type DownloadPhase =
  | "queued"
  | "downloading"
  | "paused"
  | "error"
  | "completed";
/**
 * How a phase is qualified: a stalled download is still downloading, a seeding one is completed.
 * `retrying` and `cancelling` are part of the shared vocabulary; no engine here reports them yet.
 */
export type DownloadBadge =
  | "no_progress"
  | "seeding"
  | "retrying"
  | "cancelling"
  | "cancelled";
/**
 * What the engine really supports for this one download; a tool that cannot work is not offered.
 * `retry` and `cancel` are part of the shared vocabulary; no engine here offers them yet.
 */
export type DownloadCapability =
  | "pause"
  | "resume"
  | "remove"
  | "remove_with_files"
  | "retry"
  | "cancel";

export type DownloadItem = {
  /** The engine's own id: a torrent info-hash, or an aria2 gid. Name it in pause, resume and delete. */
  hash: string;
  name: string;
  /** The download engine that owns it. */
  engine: DownloadEngine;
  /** Same as `hash`, under the name clients' Download shape uses. */
  id: string;
  phase: DownloadPhase;
  badges: DownloadBadge[];
  /** Sorted, so two reads of the same download compare equal. */
  capabilities: DownloadCapability[];
  /** The engine's own error text, when it gave one. */
  message?: string;
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
  add(input: {
    urls: string[];
    savePath?: string;
    category?: string;
    paused?: boolean;
    /** Which engine takes it, when several are configured. Omitted: magnets and .torrent go to the torrent engine. */
    engine?: string;
  }): Promise<{ submitted: number; engine?: string }>;
  list(input: {
    filter?: "all" | "downloading" | "completed" | "paused" | "errored";
    category?: string;
    limit?: number;
    /** Only this engine's downloads, when several are configured. */
    engine?: string;
  }): Promise<DownloadItem[]>;
  /**
   * Optional. Like `list`, but an engine that did not answer is named instead of failing the whole read
   * (only when none answered). Providers with a single engine simply do not have it.
   */
  listWithProblems?(input: {
    filter?: "all" | "downloading" | "completed" | "paused" | "errored";
    category?: string;
    limit?: number;
    engine?: string;
  }): Promise<{ downloads: DownloadItem[]; unreachable: string[] }>;
  get(hash: string): Promise<DownloadItem | undefined>;
  /** Optional. Providers without it simply do not expose download_pause. */
  pause?(hashes: string[]): Promise<void>;
  /** Optional. Providers without it simply do not expose download_resume. */
  resume?(hashes: string[]): Promise<void>;
  /** Optional and irreversible. Removes the tasks; deleteFiles also removes downloaded data. */
  remove?(hashes: string[], deleteFiles: boolean): Promise<void>;
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
  list(input: {
    path: string;
    page?: number;
    perPage?: number;
  }): Promise<{ entries: FileEntry[]; total: number }>;
  mkdir(path: string): Promise<void>;
  copy(input: {
    sourceDir: string;
    destinationDir: string;
    names: string[];
  }): Promise<{ taskIds: string[] }>;
  move(input: {
    sourceDir: string;
    destinationDir: string;
    names: string[];
  }): Promise<{ taskIds: string[] }>;
  offlineDownload(input: {
    urls: string[];
    destinationDir: string;
    tool?: string;
  }): Promise<{ taskIds: string[] }>;
}

export interface LibraryRefreshProvider {
  readonly service: "emby" | "jellyfin";
  /** Ask the server to scan its library folders for new files. */
  scan(): Promise<void>;
  /** Re-scrape metadata and images for one item (and everything under it). */
  refreshItem(input: {
    id: string;
    replaceAllMetadata?: boolean;
    replaceAllImages?: boolean;
  }): Promise<void>;
}

export type CloudTransferState =
  | { state: "pending"; progress?: number; message?: string }
  | { state: "completed"; contentName?: string }
  | { state: "error"; message: string };

/**
 * Network-drive transfer (网盘转存): fetches a share or direct link into a
 * directory the file manager can see. Providers own vendor details and
 * credentials; the acquisition state machine only sees submit + poll, then runs
 * the same place → scan → verify steps as a torrent job.
 */
export interface CloudTransferProvider {
  readonly service: string;
  submit(input: {
    source: string;
    destinationDir: string;
    tool?: string;
  }): Promise<{ handle: string }>;
  status(handle: string): Promise<CloudTransferState>;
}

export const PIPELINE_READ_TOOL_NAMES = [
  "download_list",
  "download_status",
  "files_list",
] as const;

export const PIPELINE_WRITE_TOOL_NAMES = [
  "download_add",
  "download_pause",
  "download_resume",
  "download_delete",
  "files_mkdir",
  "files_copy",
  "files_move",
  "files_offline_download",
  "library_scan",
  "library_refresh_item",
] as const;

export const PIPELINE_TOOL_NAMES = [
  ...PIPELINE_READ_TOOL_NAMES,
  ...PIPELINE_WRITE_TOOL_NAMES,
] as const;
export type PipelineToolName = (typeof PIPELINE_TOOL_NAMES)[number];

const stringArray = (description: string) => ({
  type: "array",
  items: { type: "string" },
  minItems: 1,
  maxItems: 20,
  description,
});

export const PIPELINE_TOOL_SCHEMAS: Record<
  PipelineToolName,
  Record<string, unknown>
> = {
  download_add: {
    type: "object",
    properties: {
      urls: stringArray(
        "Magnet links or .torrent URLs (torrent engine), or direct http(s) / ftp / sftp links (aria2). Verify the release with the user first."
      ),
      engine: {
        type: "string",
        enum: [...DOWNLOAD_ENGINES],
        description:
          "Which engine takes the links. Omit it: magnets, .torrent URLs and an indexer's download address (a release's downloadUrl from resource_search) go to qBittorrent, every other link to aria2.",
      },
      savePath: {
        type: "string",
        description:
          "Download directory on the downloader host. Omit to use its default.",
      },
      category: {
        type: "string",
        description: "Downloader category, e.g. movies or tv.",
      },
      paused: {
        type: "boolean",
        description: "Add stopped so the user can review it.",
      },
    },
    required: ["urls"],
  },
  download_pause: {
    type: "object",
    properties: {
      hashes: stringArray(
        "Download ids (`id`) from download_list or download_status: torrent info-hashes or aria2 ids. Always name the downloads; there is no pause-all."
      ),
    },
    required: ["hashes"],
  },
  download_resume: {
    type: "object",
    properties: {
      hashes: stringArray(
        "Download ids (`id`) from download_list or download_status: torrent info-hashes or aria2 ids. Always name the downloads; there is no resume-all."
      ),
    },
    required: ["hashes"],
  },
  download_delete: {
    type: "object",
    properties: {
      hashes: stringArray(
        "Download ids (`id`) from download_list or download_status: torrent info-hashes or aria2 ids. Always name the downloads; there is no delete-all."
      ),
      deleteFiles: {
        type: "boolean",
        description:
          "Required. true also deletes the downloaded files from disk and cannot be undone; false removes only the task and keeps the files. Only an item whose capabilities include remove_with_files accepts true; for aria2 that is an unfinished download, and the owner's own aria2 script does the deleting.",
      },
    },
    required: ["hashes", "deleteFiles"],
  },
  download_list: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        enum: ["all", "downloading", "completed", "paused", "errored"],
      },
      category: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      engine: {
        type: "string",
        enum: [...DOWNLOAD_ENGINES],
        description: "Only this engine's downloads. Omit it for all of them.",
      },
    },
  },
  download_status: {
    type: "object",
    properties: {
      hash: {
        type: "string",
        description:
          "Download id from download_list: a torrent info-hash or an aria2 id.",
      },
    },
    required: ["hash"],
  },
  files_list: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path in the file manager, e.g. /media/movies.",
      },
      page: { type: "integer", minimum: 1 },
      perPage: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["path"],
  },
  files_mkdir: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to create (parents are created too).",
      },
    },
    required: ["path"],
  },
  files_copy: {
    type: "object",
    properties: {
      sourceDir: { type: "string" },
      destinationDir: { type: "string" },
      names: stringArray("File or folder names inside sourceDir."),
    },
    required: ["sourceDir", "destinationDir", "names"],
  },
  files_move: {
    type: "object",
    properties: {
      sourceDir: { type: "string" },
      destinationDir: { type: "string" },
      names: stringArray("File or folder names inside sourceDir."),
    },
    required: ["sourceDir", "destinationDir", "names"],
  },
  files_offline_download: {
    type: "object",
    properties: {
      urls: stringArray(
        "Direct URLs or magnet links for the file manager's offline downloader."
      ),
      destinationDir: { type: "string" },
      tool: {
        type: "string",
        description:
          "Downloader name configured in the file manager, e.g. qBittorrent, aria2, SimpleHttp.",
      },
    },
    required: ["urls", "destinationDir"],
  },
  library_scan: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["emby", "jellyfin"],
        description: "Media server. Omit when only one is configured.",
      },
    },
  },
  library_refresh_item: {
    type: "object",
    properties: {
      provider: { type: "string", enum: ["emby", "jellyfin"] },
      id: {
        type: "string",
        description: "Library item id from emby_search / jellyfin_search.",
      },
      replaceAllMetadata: {
        type: "boolean",
        description: "Overwrite existing metadata (scrape again from scratch).",
      },
      replaceAllImages: { type: "boolean" },
    },
    required: ["id"],
  },
};

export const PIPELINE_TOOL_DESCRIPTIONS: Record<PipelineToolName, string> = {
  download_add:
    "Submit magnet, .torrent or direct links to the configured download engines (qBittorrent for torrents, aria2 for direct links). Requires approval. Afterwards poll download_status until it completes; submission is not completion.",
  download_pause:
    "Pause the named downloads without deleting them or their files. Requires approval. Afterwards confirm with download_status that state is paused.",
  download_delete:
    "Remove the named downloads from the downloader. Irreversible and requires approval. deleteFiles must be stated: false keeps the downloaded files, true deletes them too. Prefer download_pause unless the user asked to delete. Afterwards confirm with download_list.",
  download_resume:
    "Resume the named paused downloads. Requires approval. A finished download resumes as seeding. Afterwards confirm with download_status.",
  download_list:
    "List downloads from every configured engine (qBittorrent, aria2). Each has an engine, an id, a phase (queued, downloading, paused, error, completed), badges, progress and the actions its capabilities allow. An engine that did not answer is named in unreachable. Read-only.",
  download_status:
    "Get one download by id (torrent info-hash or aria2 id): phase, progress, save path and content path. Read-only.",
  files_list:
    "List a directory in the file manager (OpenList). Read-only. Use it to inspect a share or the library folder before copying.",
  files_mkdir: "Create a directory in the file manager. Requires approval.",
  files_copy:
    "Copy files or folders between directories in the file manager (asynchronous task). Requires approval.",
  files_move:
    "Move files or folders between directories in the file manager (asynchronous task). Requires approval. Prefer copy until the result is verified.",
  files_offline_download:
    "Ask the file manager to download URLs into a directory with its offline downloader (asynchronous task). Requires approval.",
  library_scan:
    "Ask Emby or Jellyfin to scan its library folders for new files. Requires approval. Scanning is asynchronous; verify with emby_search / jellyfin_search afterwards.",
  library_refresh_item:
    "Re-scrape metadata and images for one library item. Requires approval. Use after files were renamed or identified wrongly.",
};

export type ReleaseCandidate = {
  title: string;
  indexer?: string;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  publishedAt?: string;
  /** magnet: or http(s) .torrent address ready for download_add. */
  downloadUrl: string;
  infoUrl?: string;
  /** Parsed from the title when recognisable. */
  quality?: string;
};

/** Torrent search across the indexers the downloader side already trusts (Prowlarr). */
export interface ReleaseSearchProvider {
  readonly service: string;
  search(input: {
    query: string;
    type?: "movie" | "tv" | "music" | "any";
    limit?: number;
  }): Promise<ReleaseCandidate[]>;
  /**
   * Optional. Whether this address is one the indexer manager serves: a `downloadUrl` it returned, or any
   * address on its own host. Such an address fetches a torrent although it ends in no `.torrent`.
   */
  ownsAddress?(url: string): boolean;
}

export const RESOURCE_SEARCH_TOOL_NAME = "resource_search" as const;
export const PIPELINE_JOB_TOOL_NAMES = [
  "pipeline_acquire",
  "pipeline_advance",
  "pipeline_status",
] as const;
export const PIPELINE_JOB_WRITE_TOOL_NAMES = ["pipeline_acquire"] as const;
