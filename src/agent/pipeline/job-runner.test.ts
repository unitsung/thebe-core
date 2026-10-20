import { describe, expect, it, vi } from "vitest";
import { downloadItem } from "../../testing/download-item.ts";
import {
  advanceJob,
  createJobBook,
  createJob,
  magnetHash,
  type JobDeps,
  type JobSpec,
} from "./job-runner.ts";
import type {
  CloudTransferState,
  DownloadItem,
} from "../capabilities/pipeline.ts";

const hash = "a".repeat(40);
const spec: JobSpec = {
  title: "Dune",
  year: 2021,
  magnet: `magnet:?xt=urn:btih:${hash}&dn=Dune`,
  filesSourceDir: "/dl",
  libraryDir: "/media/Movies",
  mediaServer: "emby",
};

function world() {
  const state = {
    download: undefined as DownloadItem | undefined,
    folders: {
      "/dl": ["Dune.2021"],
      "/media/Movies": [] as string[],
    } as Record<string, string[]>,
    libraryHas: false,
    scans: 0,
    copies: 0,
  };
  const deps: JobDeps = {
    downloads: {
      service: "q",
      add: vi.fn(async () => {
        state.download ??= downloadItem({
          hash,
          name: "Dune.2021",
          state: "downloading",
          progress: 0.1,
        });
        return { submitted: 1 };
      }),
      list: vi.fn(),
      get: vi.fn(async () => state.download),
    },
    files: {
      service: "ol",
      list: vi.fn(async ({ path }) => ({
        total: 0,
        entries: (state.folders[path] ?? []).map((name) => ({
          name,
          path: `${path}/${name}`,
          isDirectory: true,
        })),
      })),
      mkdir: vi.fn(async () => {}),
      copy: vi.fn(async ({ destinationDir, names }) => {
        state.copies++;
        if (state.copies >= 2) state.folders[destinationDir] = names;
        return { taskIds: ["t"] };
      }),
      move: vi.fn(),
      offlineDownload: vi.fn(),
    },
    libraries: [
      {
        service: "emby",
        scan: vi.fn(async () => {
          state.scans++;
          if (state.scans >= 2) state.libraryHas = true;
        }),
        refreshItem: vi.fn(),
      },
    ],
    media: {
      emby: {
        listRecent: vi.fn(),
        listSessions: vi.fn(),
        getItem: vi.fn(),
        searchItems: vi.fn(async () => ({
          items: state.libraryHas
            ? [{ id: "9", title: "Dune", year: 2021 }]
            : [],
        })),
      } as any,
    },
    now: () => new Date(state.copies * 60_000 + 1_700_000_000_000),
  };
  return { state, deps };
}

describe("magnet hashes", () => {
  it("reads hex and base32 info-hashes", () => {
    expect(magnetHash(`magnet:?xt=urn:btih:${hash.toUpperCase()}`)).toBe(hash);
    expect(
      magnetHash("magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    ).toHaveLength(40);
    expect(magnetHash("magnet:?dn=x")).toBeUndefined();
    expect(() =>
      createJob({ ...spec, magnet: "https://x/y.torrent" }, new Date())
    ).toThrow("btih");
  });
});

describe("acquisition job", () => {
  it("waits on a running download without blocking", async () => {
    const { deps } = world();
    const job = createJob(spec, new Date());
    await advanceJob(job, deps);
    expect(job.stage).toBe("download");
    expect(job.log.at(-1)?.message).toContain("10%");
    expect(deps.files.copy).not.toHaveBeenCalled();
  });

  it("runs download → copy → scan → verify, retrying copy and scan, and ends done", async () => {
    const { deps, state } = world();
    const book = createJobBook(deps);
    const job = await book.acquire(spec);
    state.download = downloadItem({
      hash,
      name: "Dune.2021",
      state: "seeding",
      progress: 1,
      contentPath: "/data/Dune.2021",
    });
    await book.advance(job.id); // copy 1 requested but "lost"
    expect(job.stage).toBe("place");
    await book.advance(job.id); // inside the grace window: waits
    expect(state.copies).toBe(1);
    state.copies = 1;
    // time moves on (clock is derived from copies); force the retry window
    (job as any).copiedAt = 0;
    await book.advance(job.id); // copy 2 lands
    for (let i = 0; i < 6 && job.stage !== "done"; i++)
      await book.advance(job.id);
    expect(job.stage).toBe("done");
    expect(state.scans).toBe(2);
    expect(
      job.log.some((entry) => entry.message.includes("found in emby"))
    ).toBe(true);
  });

  it("fails fast with advice when the client reports an error, and resumes after a fix", async () => {
    const { deps, state } = world();
    const book = createJobBook(deps);
    const job = await book.acquire(spec);
    state.download = downloadItem({
      hash,
      name: "Dune.2021",
      state: "error",
      progress: 0.3,
    });
    await book.advance(job.id);
    expect(job.stage).toBe("failed");
    expect(job.failure?.advice).toContain("disk space");
    state.download = downloadItem({
      hash,
      name: "Dune.2021",
      state: "downloading",
      progress: 0.5,
    });
    await book.advance(job.id);
    expect(job.stage).toBe("download");
    expect(job.failure).toBeUndefined();
  });

  it("gives up with guidance when the media server never identifies the item", async () => {
    const { deps, state } = world();
    state.folders["/media/Movies"] = ["Dune.2021"];
    state.download = downloadItem({
      hash,
      name: "Dune.2021",
      state: "completed",
      progress: 1,
    });
    const job = createJob(spec, new Date());
    job.stage = "download";
    (deps.libraries![0]!.scan as any).mockImplementation(async () => {
      state.scans++;
    });
    for (let i = 0; i < 12 && (job.stage as string) !== "failed"; i++)
      await advanceJob(job, deps);
    expect(job.stage).toBe("failed");
    expect(job.failure?.advice).toContain("refresh_item");
    expect(state.scans).toBe(3);
  });

  it("stops after repeated provider exceptions instead of looping", async () => {
    const { deps } = world();
    (deps.downloads!.add as any).mockRejectedValue(
      new Error("connection refused")
    );
    const job = createJob(spec, new Date());
    for (let i = 0; i < 4; i++) await advanceJob(job, deps);
    expect(job.stage).toBe("failed");
    expect(job.failure?.reason).toContain("connection refused");
  });
});

describe("cloud transfer job", () => {
  const cloudSpec: JobSpec = {
    kind: "cloud_transfer",
    title: "Dune",
    year: 2021,
    transferSource: "https://pan.example/s/abc",
    filesSourceDir: "/dl",
    libraryDir: "/media/Movies",
    mediaServer: "emby",
  };

  function transfer(state: { current: CloudTransferState }) {
    return {
      service: "ol",
      submit: vi.fn(async () => ({ handle: "t1" })),
      status: vi.fn(async () => state.current),
    };
  }

  it("waits on the transfer, then runs place → scan → verify and ends done", async () => {
    const { deps, state } = world();
    state.folders["/dl"] = ["Dune.2021"];
    const transferState = {
      current: { state: "pending", progress: 0.5 } as CloudTransferState,
    };
    deps.transfer = transfer(transferState);
    const book = createJobBook(deps);
    const job = await book.acquire(cloudSpec);
    expect(job.kind).toBe("cloud_transfer");
    expect(job.hash).toBeUndefined();
    expect(job.stage).toBe("download");
    expect(job.transferHandle).toBe("t1");
    expect(job.log.at(-1)?.message).toContain("50%");

    transferState.current = {
      state: "completed",
      contentName: "/cloud/Dune.2021",
    };
    state.copies = 1;
    await book.advance(job.id); // download → place, first copy requested
    (job as any).copiedAt = 0;
    for (let i = 0; i < 8 && job.stage !== "done"; i++)
      await book.advance(job.id);
    expect(job.contentName).toBe("Dune.2021");
    expect(job.stage).toBe("done");
    expect(
      job.log.some((entry) => entry.message.includes("found in emby"))
    ).toBe(true);
  });

  it("fails with advice when the transfer itself fails", async () => {
    const { deps } = world();
    deps.transfer = transfer({
      current: { state: "error", message: "link expired" },
    });
    const job = createJob(cloudSpec, new Date());
    await advanceJob(job, deps);
    expect(job.stage).toBe("failed");
    expect(job.failure?.advice).toContain("link expired");
  });

  it("requires a transfer source", () => {
    expect(() =>
      createJob({ ...cloudSpec, transferSource: undefined }, new Date())
    ).toThrow("transferSource");
  });

  it("fails clearly when no transfer provider is configured", async () => {
    const { deps } = world();
    const job = createJob(cloudSpec, new Date());
    await advanceJob(job, deps);
    expect(job.stage).toBe("failed");
    expect(job.failure?.advice).toContain("transfer backend");
  });

  it("restarts a cloud transfer from submit after a failed submit, not from download", async () => {
    const { deps } = world();
    let failSubmit = true;
    deps.transfer = {
      service: "ol",
      submit: vi.fn(async () => {
        if (failSubmit) throw new Error("no space");
        return { handle: "t9" };
      }),
      status: vi.fn(async () => ({ state: "pending" }) as CloudTransferState),
    };
    const book = createJobBook(deps);
    let job = await book.acquire(cloudSpec);
    for (let i = 0; i < 4 && job.stage !== "failed"; i++)
      job = await book.advance(job.id);
    expect(job.stage).toBe("failed");
    expect(job.transferHandle).toBeUndefined();

    failSubmit = false;
    job = await book.advance(job.id);
    expect(job.stage).toBe("download");
    expect(job.transferHandle).toBe("t9");
    expect(job.failure).toBeUndefined();
  });

  it("is exposed through pipeline.acquire only when a transfer backend exists", async () => {
    const files = {
      service: "ol",
      list: vi.fn(),
      mkdir: vi.fn(),
      copy: vi.fn(),
      move: vi.fn(),
      offlineDownload: vi.fn(),
    };
    const { allPipelineToolNames, createPipelineTools } =
      await import("../tools/pipeline-tools.ts");
    expect(allPipelineToolNames({ files })).not.toContain("pipeline.acquire");
    expect(
      allPipelineToolNames({
        files,
        transfer: transfer({ current: { state: "pending" } }),
      })
    ).toContain("pipeline.acquire");
    const allow = { allow: () => ({ ok: true }) } as any;
    const acquired: string[] = [];
    const sharedBook = createJobBook({
      files,
      transfer: transfer({ current: { state: "pending" } }),
    });
    const tool = createPipelineTools(
      { files, transfer: transfer({ current: { state: "pending" } }) },
      {
        policy: allow,
        callerId: "c",
        book: sharedBook,
        onAcquired: (jobId) => acquired.push(jobId),
      }
    ).find((candidate) => candidate.name === "pipeline.acquire")!;
    expect(tool).toBeDefined();
    const result = await tool.execute("1", {
      kind: "cloud_transfer",
      title: "Dune",
      transferSource: "https://pan.example/s/abc",
      filesSourceDir: "/dl",
      libraryDir: "/media/Movies",
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload).toMatchObject({
      kind: "cloud_transfer",
      stage: "download",
    });
    // The tool records the new job on the shared book so the advancer can track it.
    expect(acquired).toEqual([payload.jobId]);
    expect(sharedBook.status(payload.jobId)).toHaveLength(1);
  });
});
