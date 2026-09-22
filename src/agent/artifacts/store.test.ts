import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "./store.ts";

describe("ArtifactStore", () => {
  it("restores metadata and bounded content after recreation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-artifacts-"));
    const now = () => new Date("2026-09-21T00:00:00.000Z");
    const first = createArtifactStore({ dir, now });

    const created = await first.create({
      kind: "report",
      title: "Health report",
      contentType: "text/plain",
      content: "healthy",
    });

    expect(created).toEqual(expect.objectContaining({
      artifactId: expect.any(String),
      kind: "report",
      title: "Health report",
      contentType: "text/plain",
      sizeBytes: 7,
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    }));

    const second = createArtifactStore({ dir, now });
    await expect(second.get(created.artifactId)).resolves.toEqual(created);
    await expect(second.getContent(created.artifactId)).resolves.toEqual({
      artifact: created,
      content: "healthy",
    });
  });

  it("shares one reload when metadata and content are read concurrently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-artifacts-concurrent-reload-"));
    const now = () => new Date("2026-09-21T00:00:00.000Z");
    const first = createArtifactStore({ dir, now });
    const created = await first.create({
      kind: "report",
      title: "Concurrent report",
      content: "ready",
    });

    const second = createArtifactStore({ dir, now });
    const [listed, content] = await Promise.all([
      second.list(),
      second.getContent(created.artifactId),
    ]);

    expect(listed).toEqual([created]);
    expect(content).toEqual({ artifact: created, content: "ready" });
  });

  it("serves content from memory when no persistence directory is configured", async () => {
    const store = createArtifactStore({
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });
    const artifact = await store.create({
      kind: "report",
      title: "In-memory report",
      content: "available",
    });

    await expect(store.getContent(artifact.artifactId)).resolves.toEqual({
      artifact,
      content: "available",
    });
  });

  it("redacts secrets before writing Artifact content to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-artifacts-redaction-"));
    const secret = "sk-live-artifact-secret";
    const store = createArtifactStore({
      dir,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });
    const artifact = await store.create({
      kind: "report",
      title: "Redacted report",
      contentType: "application/json",
      content: JSON.stringify({ apiToken: secret, summary: "safe" }),
    });

    const onDisk = await readFile(join(dir, `${artifact.artifactId}.content`), "utf8");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain("***REDACTED***");
    await expect(store.getContent(artifact.artifactId)).resolves.toEqual({
      artifact,
      content: onDisk,
    });
  });

  it("rejects invalid kinds and content beyond the configured byte limit", async () => {
    const store = createArtifactStore({
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      maxContentBytes: 4,
    });

    await expect(store.create({
      kind: "unknown" as never,
      title: "Invalid",
      content: "ok",
    })).rejects.toThrow("invalid artifact kind");
    await expect(store.create({
      kind: "report",
      title: "Too large",
      content: "12345",
    })).rejects.toThrow("artifact content exceeds 4 bytes");
  });

  it("bounds retention and skips corrupt metadata on reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-artifacts-retention-"));
    let tick = 0;
    const store = createArtifactStore({
      dir,
      maxItems: 1,
      now: () => new Date(`2026-09-21T00:00:0${tick++}.000Z`),
    });
    const first = await store.create({ kind: "report", title: "First", content: "1" });
    const second = await store.create({ kind: "report", title: "Second", content: "2" });
    await expect(store.get(first.artifactId)).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([second]);

    await writeFile(join(dir, "corrupt.json"), "not json", "utf8");
    const reloaded = createArtifactStore({
      dir,
      maxItems: 1,
      now: () => new Date("2026-09-21T00:00:10.000Z"),
    });
    await expect(reloaded.list()).resolves.toEqual([second]);
    await expect(reloaded.getContent("../escape")).rejects.toThrow("invalid artifact id");
  });
});
