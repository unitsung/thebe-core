import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertMetadataOnly, createAgentStore } from "./store.ts";

describe("AgentStore", () => {
  it("persists mapping metadata only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-agent-"));
    const store = createAgentStore(dir);
    await store.save({
      thebeSessionId: "thebe-1",
      runtimeId: "pi-coding-agent",
      runtimeSessionId: "runtime-1",
      labels: { env: "lab" },
    });
    const loaded = await store.load("thebe-1");
    expect(loaded).toEqual({
      thebeSessionId: "thebe-1",
      runtimeId: "pi-coding-agent",
      runtimeSessionId: "runtime-1",
      labels: { env: "lab" },
    });
    const raw = await readFile(join(dir, "thebe-1.json"), "utf8");
    expect(raw).not.toContain("transcript");
    expect(raw).not.toContain("messages");
    expect(raw).not.toContain("compaction");
    expect(raw).not.toContain("refresh_token");
    expect(await store.list()).toHaveLength(1);
    expect(await readdir(dir)).toEqual(["thebe-1.json"]);
    await store.delete("thebe-1");
    expect(await store.list()).toHaveLength(0);
  });

  it("rejects Pi payload keys", () => {
    expect(() =>
      assertMetadataOnly({
        thebeSessionId: "x",
        transcript: [],
      })
    ).toThrow(/transcript/);
  });

  it("writes atomically so a concurrent list never reads a partial file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-agent-atomic-"));
    const store = createAgentStore(dir);
    const ids = Array.from({ length: 50 }, (_, i) => `thebe-${i}`);
    const base = { runtimeId: "pi-coding-agent", runtimeSessionId: "runtime" };

    // Interleave writes and reads: a non-atomic save would let a read observe a
    // truncated (empty) file and fail JSON.parse.
    await Promise.all([
      ...ids.map((id) => store.save({ thebeSessionId: id, ...base })),
      ...ids.map(() => store.list()),
    ]);

    // No temp files leak, and every stored record is complete.
    const names = await readdir(dir);
    expect(names.every((name) => name.endsWith(".json"))).toBe(true);
    expect(await store.list()).toHaveLength(ids.length);
  });

  it("keeps listing valid sessions when one mapping file is damaged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-agent-damaged-"));
    const store = createAgentStore(dir);
    await store.save({
      thebeSessionId: "thebe-1",
      runtimeId: "pi-coding-agent",
      runtimeSessionId: "runtime-1",
    });
    await writeFile(join(dir, "damaged.json"), '{"runtimeId":');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect((await store.list()).map((row) => row.thebeSessionId)).toEqual([
        "thebe-1",
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("damaged.json")
      );
    } finally {
      warn.mockRestore();
    }
  });
});
