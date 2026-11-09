import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../capabilities/containers.ts";
import type { MediaLibraryProvider } from "../capabilities/media.ts";
import type {
  DownloadItem,
  DownloadPhase,
  DownloadProvider,
} from "../capabilities/pipeline.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

afterEach(() => vi.useRealTimers());

const containerProvider: ContainerInfoProvider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => "",
  getStatusSummary: async () => ({
    totalContainers: 0,
    runningContainers: 0,
    pausedContainers: 0,
    exitedContainers: 0,
    lastUpdated: 1,
  }),
};

function download(phase: DownloadPhase): DownloadItem {
  return {
    hash: "b".repeat(40),
    id: "b".repeat(40),
    engine: "qbittorrent",
    name: "Example.Movie.2024.1080p.WEB-DL.x265.mkv",
    phase,
    badges: phase === "completed" ? ["seeding"] : [],
    capabilities: [],
    state: phase === "completed" ? "seeding" : phase,
    progress: phase === "completed" ? 1 : 0.5,
    sizeBytes: 4096,
    contentPath: "/downloads/Example.Movie.2024",
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

describe("download completion preparation, end to end", () => {
  it("searches the library read-only before an observe Decision", async () => {
    vi.useFakeTimers();
    let current = download("downloading");
    const downloads: DownloadProvider = {
      service: "downloads",
      add: async () => ({ submitted: 0 }),
      list: async () => [{ ...current }],
      get: async () => ({ ...current }),
    };
    const searchItems = vi.fn(async () => ({
      items: [{ id: "media-1", title: "Example Movie", year: 2024 }],
      total: 1,
    }));
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: containerProvider,
      pipeline: { downloads },
      emby: mediaLibrary(searchItems),
      sources: { downloadCompleted: true, intervalMs: 1000 },
      agentStoreDir: await mkdtemp(join(tmpdir(), "thebe-download-eval-")),
    });
    await vi.advanceTimersByTimeAsync(0);
    const policy = await app.agent.setPolicy({
      rules: [
        "When a wanted movie finishes downloading, check whether it is in the library.",
      ],
      acceptMode: "observe",
    });
    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [policy.rules[0]!.id],
          intent: "check the completed movie in the library",
          reason: "the wanted movie completed",
        }),
      },
    ]);

    current = download("completed");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect(await app.agent.listDecisions()).toHaveLength(1);
    });

    expect(await app.agent.listDecisions()).toEqual([
      expect.objectContaining({
        outcome: "ignore",
        wouldAccept: true,
        thread: `resource:download:qbittorrent:${"b".repeat(40)}`,
      }),
    ]);
    expect(searchItems).toHaveBeenCalledWith({
      query: "Example Movie 2024",
      limit: 5,
    });
    expect(await app.agent.listTickets()).toEqual([]);
    expect(await app.agent.listArtifacts()).toEqual([]);
    await app.agent.quiesce();
  });
});
