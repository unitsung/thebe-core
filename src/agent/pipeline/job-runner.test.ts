import { describe, expect, it, vi } from "vitest";
import { advanceJob, createJobBook, createJob, magnetHash, type JobDeps, type JobSpec } from "./job-runner.ts";
import type { DownloadItem } from "../capabilities/pipeline.ts";

const hash = "a".repeat(40);
const spec: JobSpec = {
  title: "Dune", year: 2021, magnet: `magnet:?xt=urn:btih:${hash}&dn=Dune`,
  filesSourceDir: "/dl", libraryDir: "/media/Movies", mediaServer: "emby",
};

function world() {
  const state = {
    download: undefined as DownloadItem | undefined,
    folders: { "/dl": ["Dune.2021"], "/media/Movies": [] as string[] } as Record<string, string[]>,
    libraryHas: false,
    scans: 0,
    copies: 0,
  };
  const deps: JobDeps = {
    downloads: {
      service: "q",
      add: vi.fn(async () => { state.download ??= { hash, name: "Dune.2021", state: "downloading", progress: 0.1 }; return { submitted: 1 }; }),
      list: vi.fn(), get: vi.fn(async () => state.download),
    },
    files: {
      service: "ol",
      list: vi.fn(async ({ path }) => ({ total: 0, entries: (state.folders[path] ?? []).map(name => ({ name, path: `${path}/${name}`, isDirectory: true })) })),
      mkdir: vi.fn(async () => {}),
      copy: vi.fn(async ({ destinationDir, names }) => { state.copies++; if (state.copies >= 2) state.folders[destinationDir] = names; return { taskIds: ["t"] }; }),
      move: vi.fn(), offlineDownload: vi.fn(),
    },
    libraries: [{ service: "emby", scan: vi.fn(async () => { state.scans++; if (state.scans >= 2) state.libraryHas = true; }), refreshItem: vi.fn() }],
    media: { emby: { listRecent: vi.fn(), listSessions: vi.fn(), getItem: vi.fn(), searchItems: vi.fn(async () => ({ items: state.libraryHas ? [{ id: "9", title: "Dune", year: 2021 }] : [] })) } as any },
    now: () => new Date(state.copies * 60_000 + 1_700_000_000_000),
  };
  return { state, deps };
}

describe("magnet hashes", () => {
  it("reads hex and base32 info-hashes", () => {
    expect(magnetHash(`magnet:?xt=urn:btih:${hash.toUpperCase()}`)).toBe(hash);
    expect(magnetHash("magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")).toHaveLength(40);
    expect(magnetHash("magnet:?dn=x")).toBeUndefined();
    expect(() => createJob({ ...spec, magnet: "https://x/y.torrent" }, new Date())).toThrow("btih");
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
    state.download = { hash, name: "Dune.2021", state: "seeding", progress: 1, contentPath: "/data/Dune.2021" };
    await book.advance(job.id); // copy 1 requested but "lost"
    expect(job.stage).toBe("place");
    await book.advance(job.id); // inside the grace window: waits
    expect(state.copies).toBe(1);
    state.copies = 1;
    // time moves on (clock is derived from copies); force the retry window
    (job as any).copiedAt = 0;
    await book.advance(job.id); // copy 2 lands
    for (let i = 0; i < 6 && job.stage !== "done"; i++) await book.advance(job.id);
    expect(job.stage).toBe("done");
    expect(state.scans).toBe(2);
    expect(job.log.some(entry => entry.message.includes("found in emby"))).toBe(true);
  });

  it("fails fast with advice when the client reports an error, and resumes after a fix", async () => {
    const { deps, state } = world();
    const book = createJobBook(deps);
    const job = await book.acquire(spec);
    state.download = { hash, name: "Dune.2021", state: "error", progress: 0.3 };
    await book.advance(job.id);
    expect(job.stage).toBe("failed");
    expect(job.failure?.advice).toContain("disk space");
    state.download = { hash, name: "Dune.2021", state: "downloading", progress: 0.5 };
    await book.advance(job.id);
    expect(job.stage).toBe("download");
    expect(job.failure).toBeUndefined();
  });

  it("gives up with guidance when the media server never identifies the item", async () => {
    const { deps, state } = world();
    state.folders["/media/Movies"] = ["Dune.2021"];
    state.download = { hash, name: "Dune.2021", state: "completed", progress: 1 };
    const job = createJob(spec, new Date());
    job.stage = "download";
    (deps.libraries![0]!.scan as any).mockImplementation(async () => { state.scans++; });
    for (let i = 0; i < 12 && (job.stage as string) !== "failed"; i++) await advanceJob(job, deps);
    expect(job.stage).toBe("failed");
    expect(job.failure?.advice).toContain("refresh_item");
    expect(state.scans).toBe(3);
  });

  it("stops after repeated provider exceptions instead of looping", async () => {
    const { deps } = world();
    (deps.downloads.add as any).mockRejectedValue(new Error("connection refused"));
    const job = createJob(spec, new Date());
    for (let i = 0; i < 4; i++) await advanceJob(job, deps);
    expect(job.stage).toBe("failed");
    expect(job.failure?.reason).toContain("connection refused");
  });
});
