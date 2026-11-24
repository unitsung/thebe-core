import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Trigger } from "../sources/types.ts";
import { createCorrelationStore } from "./store.ts";

const trigger: Trigger = {
  id: "a".repeat(32),
  source: "github",
  kind: "pull_request.checks_changed",
  at: "2026-11-24T10:00:00.000Z",
  threads: ["resource:github:pull:7", "resource:github:check:9"],
  payload: {},
};

describe("correlations", () => {
  it("persists one relation for Threads that share a Trigger and restores it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-correlations-"));
    const first = createCorrelationStore({ dir });

    const [relation] = await first.record([trigger]);

    expect(relation).toMatchObject({
      triggerId: trigger.id,
      primaryThread: trigger.threads[0],
      threads: trigger.threads,
    });
    expect(relation!.id).toMatch(/^[a-f0-9]{32}$/);
    expect(await first.record([trigger])).toEqual([relation]);

    const reopened = createCorrelationStore({ dir });
    await expect(reopened.forTrigger([trigger.id])).resolves.toEqual([
      relation,
    ]);
    await expect(
      reopened.forThread("resource:github:check:9")
    ).resolves.toEqual([relation]);
  });
});
