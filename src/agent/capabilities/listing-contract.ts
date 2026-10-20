import type { ContainerSummary } from "./containers.ts";
import type { DownloadItem, FileEntry } from "./pipeline.ts";

/**
 * Results the App turns into tables and file lists, exported as data. Core owns the shapes; the App
 * keeps a copy under `ui/Tests/Fixtures/contracts` (`scripts/sync-core-contract.sh --check` fails on
 * drift) and checks that its card specs read these fields.
 */
export const LISTING_CONTRACT_PATH = "contracts/listing-results.json";

export const CONTAINER_LIST_EXAMPLE = [
  {
    id: "c1",
    name: "emby",
    image: "emby/embyserver:latest",
    state: "running",
    status: "Up 3 days",
    created: 1760000000,
  },
  {
    id: "c2",
    name: "qbittorrent",
    image: "linuxserver/qbittorrent",
    state: "exited",
    status: "Exited (1) 2 hours ago",
    created: 1760000100,
  },
] satisfies ContainerSummary[];

export const DOWNLOAD_LIST_EXAMPLE = {
  downloads: [
    {
      hash: "0123456789abcdef0123456789abcdef01234567",
      id: "0123456789abcdef0123456789abcdef01234567",
      engine: "qbittorrent",
      phase: "downloading",
      badges: [],
      capabilities: ["pause", "remove", "remove_with_files"],
      name: "Dune.Part.Two.2024.2160p",
      state: "downloading",
      progress: 0.42,
      sizeBytes: 21474836480,
      downloadSpeedBytes: 5242880,
      etaSeconds: 3600,
      category: "movies",
    },
    {
      hash: "fedcba9876543210fedcba9876543210fedcba98",
      id: "fedcba9876543210fedcba9876543210fedcba98",
      engine: "qbittorrent",
      phase: "completed",
      badges: ["seeding"],
      capabilities: ["pause", "remove", "remove_with_files"],
      name: "Album.FLAC",
      state: "completed",
      progress: 1,
      sizeBytes: 734003200,
    },
  ],
} satisfies { downloads: DownloadItem[] };

export const FILES_LIST_EXAMPLE = {
  entries: [
    { name: "Movies", path: "/media/Movies", isDirectory: true },
    {
      name: "Dune.mkv",
      path: "/media/Dune.mkv",
      isDirectory: false,
      sizeBytes: 21474836480,
      modifiedAt: "2026-10-01T08:30:00Z",
    },
  ],
  total: 2,
} satisfies { entries: FileEntry[]; total: number };

export function buildListingContract() {
  return {
    version: 1,
    examples: {
      "container.list": CONTAINER_LIST_EXAMPLE,
      "download.list": DOWNLOAD_LIST_EXAMPLE,
      "files.list": FILES_LIST_EXAMPLE,
    },
  };
}
