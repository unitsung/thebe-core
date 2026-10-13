import { describe, expect, it, vi } from "vitest";
import { createJobBook } from "./job-runner.ts";
import {
  createPipelineAdvancer,
  pipelineAdvanceIntervalMs,
} from "./advancer.ts";
import type { DownloadItem } from "../capabilities/pipeline.ts";

const hash = "a".repeat(40);
const torrentSpec = {
  title: "Dune",
  magnet: `magnet:?xt=urn:btih:${hash}`,
  filesSourceDir: "/dl",
  libraryDir: "/media/Movies",
};

function world() {
  const state = {
    download: {
      hash,
      name: "Dune.2021",
      state: "downloading",
      progress: 0.1,
    } as DownloadItem,
    folders: {
      "/dl": ["Dune.2021"],
      "/media/Movies": [] as string[],
    } as Record<string, string[]>,
  };
  const deps = {
    downloads: {
      service: "q",
      add: vi.fn(async () => ({ submitted: 1 })),
      list: vi.fn(),
      get: vi.fn(async () => state.download),
    },
    files: {
      service: "ol",
      list: vi.fn(async ({ path }: { path: string }) => ({
        total: 0,
        entries: (state.folders[path] ?? []).map((name) => ({
          name,
          path: `${path}/${name}`,
          isDirectory: true,
        })),
      })),
      mkdir: vi.fn(async () => {}),
      copy: vi.fn(async () => ({ taskIds: ["t"] })),
      move: vi.fn(),
      offlineDownload: vi.fn(),
    },
  };
  return { state, deps };
}

describe("pipeline advancer", () => {
  it("keeps tracked jobs moving and leaves restored jobs alone", async () => {
    const { state, deps } = world();
    const book = createJobBook(deps);
    const job = await book.acquire(torrentSpec);
    expect(book.status(job.id)[0]!.stage).toBe("download");

    const advancer = createPipelineAdvancer({ book, intervalMs: 0 });
    state.download = {
      hash,
      name: "Dune.2021",
      state: "completed",
      progress: 1,
    };

    // A job restored from disk was never acquired in this process: no auto-run.
    await advancer.runOnce();
    expect(book.status(job.id)[0]!.stage).toBe("download");

    advancer.track(job.id);
    await advancer.runOnce();
    expect(book.status(job.id)[0]!.stage).toBe("place");
    expect(advancer.size()).toBe(1);
  });

  it("stops tracking terminal jobs and never retries a failure by itself", async () => {
    const { state, deps } = world();
    const book = createJobBook(deps);
    const advancer = createPipelineAdvancer({ book, intervalMs: 0 });
    const job = await book.acquire(torrentSpec);
    advancer.track(job.id);

    state.download = { hash, name: "Dune.2021", state: "error", progress: 0.2 };
    await advancer.runOnce();
    expect(book.status(job.id)[0]!.stage).toBe("failed");
    expect(advancer.size()).toBe(0);

    state.download = {
      hash,
      name: "Dune.2021",
      state: "downloading",
      progress: 0.5,
    };
    await advancer.runOnce();
    expect(book.status(job.id)[0]!.stage).toBe("failed");
  });

  it("does nothing while quiesced", async () => {
    const { state, deps } = world();
    const book = createJobBook(deps);
    const advancer = createPipelineAdvancer({
      book,
      intervalMs: 0,
      isQuiesced: () => true,
    });
    const job = await book.acquire(torrentSpec);
    advancer.track(job.id);
    state.download = {
      hash,
      name: "Dune.2021",
      state: "completed",
      progress: 1,
    };

    expect(await advancer.runOnce()).toEqual([]);
    expect(book.status(job.id)[0]!.stage).toBe("download");
  });

  it("keeps going when one provider fails and reports through onError", async () => {
    const { deps } = world();
    const book = createJobBook(deps);
    const job = await book.acquire(torrentSpec);
    const errors: unknown[] = [];
    const advancer = createPipelineAdvancer({
      book,
      intervalMs: 0,
      onError: (error) => errors.push(error),
    });
    advancer.track(job.id);
    const spy = vi
      .spyOn(book, "advance")
      .mockRejectedValueOnce(new Error("provider down"));
    await advancer.runOnce();
    expect(errors).toHaveLength(1);
    // A transient failure stays tracked so the next tick retries it.
    expect(advancer.size()).toBe(1);
    spy.mockRestore();
  });
});

describe("pipeline advance interval", () => {
  it("defaults to one minute and can be disabled", () => {
    expect(pipelineAdvanceIntervalMs({})).toBe(60_000);
    expect(
      pipelineAdvanceIntervalMs({ THEBE_PIPELINE_ADVANCE_MS: "1500" })
    ).toBe(1500);
    expect(pipelineAdvanceIntervalMs({ THEBE_PIPELINE_ADVANCE_MS: "0" })).toBe(
      0
    );
    expect(
      pipelineAdvanceIntervalMs({ THEBE_PIPELINE_ADVANCE_MS: "nonsense" })
    ).toBe(60_000);
  });
});
