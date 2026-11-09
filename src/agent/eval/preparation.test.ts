import { describe, expect, it, vi } from "vitest";
import type { MediaLibraryProvider } from "../capabilities/media.ts";
import type {
  DownloadItem,
  DownloadProvider,
} from "../capabilities/pipeline.ts";
import type { DiagnosisPreview } from "../diagnosis/service.ts";
import type { Trigger } from "../sources/types.ts";
import { prepareForEval, searchableTitle } from "./preparation.ts";

const NOW = new Date("2026-11-10T08:00:00.000Z");

function downloadTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "a".repeat(32),
    source: "download-completed",
    kind: "download.completed",
    at: "2026-11-10T07:59:00.000Z",
    threads: [`resource:download:qbittorrent:${"b".repeat(40)}`],
    resource: {
      kind: "download",
      id: `qbittorrent:${"b".repeat(40)}`,
    },
    payload: {
      engine: "qbittorrent",
      hash: "b".repeat(40),
      name: "Example.Movie.2024.1080p.WEB-DL.x265.mkv",
      sizeBytes: 4096,
      contentPath: "/downloads/Example.Movie.2024",
    },
    ...overrides,
  };
}

function downloadItem(): DownloadItem {
  return {
    hash: "b".repeat(40),
    id: "b".repeat(40),
    engine: "qbittorrent",
    name: "Example.Movie.2024.1080p.WEB-DL.x265.mkv",
    phase: "completed",
    badges: ["seeding"],
    capabilities: [],
    state: "seeding",
    progress: 1,
    sizeBytes: 4096,
    contentPath: "/downloads/Example.Movie.2024",
  };
}

function downloads(
  get: DownloadProvider["get"] = async () => downloadItem()
): DownloadProvider {
  return {
    service: "downloads",
    add: async () => ({ submitted: 0 }),
    list: async () => [downloadItem()],
    get,
  };
}

function mediaLibrary(
  searchItems: MediaLibraryProvider["searchItems"]
): MediaLibraryProvider {
  return {
    listLibraries: async () => [],
    listRecent: async () => [],
    listSessions: async () => [],
    searchItems,
    getItem: async () => undefined,
  };
}

describe("read-only preparation for Eval", () => {
  it("rechecks a completed download and searches configured libraries without writing", async () => {
    const searchItems = vi.fn(async () => ({
      items: [
        {
          id: "media-1",
          title: "Example Movie",
          year: 2024,
        },
      ],
      total: 1,
    }));
    const preparation = await prepareForEval([downloadTrigger()], {
      diagnosis: {
        preview: async () => {
          throw new Error("not a container");
        },
      },
      now: () => NOW,
      downloads: downloads(),
      mediaLibraries: [
        { service: "emby", provider: mediaLibrary(searchItems) },
      ],
    });

    expect(searchItems).toHaveBeenCalledWith({
      query: "Example Movie 2024",
      limit: 5,
    });
    expect(preparation).toMatchObject({
      source: "download-completed",
      observedAt: NOW.toISOString(),
      resource: {
        kind: "download",
        id: `qbittorrent:${"b".repeat(40)}`,
      },
      suggestions: [
        {
          kind: "read",
          requiresApproval: false,
        },
      ],
    });
    expect(preparation?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "download",
          fact: expect.stringContaining(
            "Current downloader state is completed"
          ),
        }),
        expect.objectContaining({
          kind: "library",
          fact: expect.stringContaining("Example Movie (2024)"),
        }),
      ])
    );
  });

  it("keeps the completed-download facts when provider reads fail", async () => {
    const preparation = await prepareForEval([downloadTrigger()], {
      diagnosis: {
        preview: async () => {
          throw new Error("not a container");
        },
      },
      now: () => NOW,
      downloads: downloads(async () => {
        throw new Error("downloader offline");
      }),
      mediaLibraries: [
        {
          service: "jellyfin",
          provider: mediaLibrary(async () => {
            throw new Error("library offline");
          }),
        },
      ],
    });

    expect(preparation).toMatchObject({ source: "download-completed" });
    expect(preparation?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: expect.stringContaining("reached completed"),
        }),
        expect.objectContaining({
          fact: "The current downloader state could not be read.",
        }),
        expect.objectContaining({
          fact: "Jellyfin library search could not be read.",
        }),
      ])
    );
  });

  it("bounds container diagnosis evidence before it reaches a prompt", async () => {
    const preview: DiagnosisPreview = {
      resource: { kind: "container", id: "emby", provider: "unknown" },
      observedAt: NOW.toISOString(),
      diagnosis: {
        code: "container_exited",
        title: "Container is not running",
        summary: "Observed state for emby is exited.",
        confidence: "high",
        tokenUsed: false,
      },
      observations: Array.from({ length: 12 }, (_, index) => ({
        id: `obs-${index}`,
        kind: "logs",
        fact: `fact-${index}-${"x".repeat(700)}`,
        source: "container_logs",
        observedAt: NOW.toISOString(),
        resource: {
          kind: "container",
          id: "emby",
          provider: "unknown",
        },
        severity: "error",
      })),
      recommendations: Array.from({ length: 5 }, (_, index) => ({
        id: `rec-${index}`,
        title: `recommendation-${index}`,
        detail: "read-only suggestion",
        kind: "read",
        requiresApproval: false,
      })),
    };
    const preparation = await prepareForEval(
      [
        {
          ...downloadTrigger(),
          source: "container-health",
          kind: "container.went_down",
          threads: ["resource:container:emby"],
          resource: { kind: "container", id: "emby" },
          payload: { from: "running", to: "exited" },
        },
      ],
      {
        diagnosis: { preview: async () => preview },
        now: () => NOW,
      }
    );

    expect(preparation?.observations).toHaveLength(8);
    expect(
      preparation?.observations.every((row) => row.fact.length === 600)
    ).toBe(true);
    expect(preparation?.suggestions).toHaveLength(4);
  });
});

describe("searchable download title", () => {
  it("strips file and release noise while keeping the year", () => {
    expect(
      searchableTitle("Example.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv")
    ).toBe("Example Movie 2024");
    expect(searchableTitle("Dune_Part_Two_(2024)_2160p")).toBe(
      "Dune Part Two (2024)"
    );
  });
});
