import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertMetadataOnly, createProductStore } from "./store.ts";

describe("ProductStore", () => {
  it("persists mapping metadata only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-product-"));
    const store = createProductStore(dir);
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
  });

  it("rejects Pi payload keys", () => {
    expect(() =>
      assertMetadataOnly({
        thebeSessionId: "x",
        transcript: [],
      }),
    ).toThrow(/transcript/);
  });
});
