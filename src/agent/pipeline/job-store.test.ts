import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileJobStore } from "./job-store.ts";
import { createJob, type Job } from "./job-runner.ts";

describe("file job store", () => {
  it("round-trips torrent and cloud-transfer jobs and drops malformed rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-job-store-"));
    const path = join(dir, "pipeline-jobs.json");
    const store = createFileJobStore(path);
    const torrent = createJob(
      {
        title: "Dune",
        magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
        filesSourceDir: "/dl",
        libraryDir: "/media",
      },
      new Date("2026-10-13T00:00:00Z")
    );
    const cloud = createJob(
      {
        kind: "cloud_transfer",
        title: "Frieren",
        transferSource: "https://pan.example/s/x",
        filesSourceDir: "/cloud",
        libraryDir: "/media",
      },
      new Date("2026-10-13T00:00:00Z")
    );
    store.save([torrent, cloud]);

    const loaded = store.load();
    expect(loaded.map((job) => job.id).sort()).toEqual(
      [torrent.id, cloud.id].sort()
    );
    expect(loaded.find((job) => job.id === cloud.id)?.kind).toBe(
      "cloud_transfer"
    );
    expect(loaded.find((job) => job.id === cloud.id)?.hash).toBeUndefined();

    await writeFile(
      path,
      JSON.stringify([{ nope: true }, { id: "x" }, torrent])
    );
    const filtered = store.load();
    expect(filtered.map((job) => job.id)).toEqual([torrent.id]);
  });

  it("returns an empty list for a missing or corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-job-store-bad-"));
    const path = join(dir, "jobs.json");
    const store = createFileJobStore(path);
    expect(store.load()).toEqual([]);
    await writeFile(path, "{ not json");
    expect(store.load()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  it("does not replace a jobs file it cannot parse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-job-store-corrupt-"));
    const path = join(dir, "jobs.json");
    await writeFile(path, "{ not json");
    const store = createFileJobStore(path);
    const job = createJob(
      {
        title: "Dune",
        magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
        filesSourceDir: "/dl",
        libraryDir: "/media",
      },
      new Date("2026-10-13T00:00:00Z")
    );

    store.save([job]);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  it("does not throw when the directory cannot be written", () => {
    const store = createFileJobStore(
      join(tmpdir(), "thebe-missing-dir", "..", "\u0000bad", "jobs.json")
    );
    expect(() => store.save([{ id: "x", stage: "done" } as Job])).not.toThrow();
  });
});
