import { describe, expect, it } from "vitest";
import { key } from "../tickets/ids.ts";
import { createSourceRunner } from "./runner.ts";
import { createTriggerStore } from "./store.ts";
import type { Source, Trigger } from "./types.ts";

function trigger(seq: number): Trigger {
  return {
    id: key("trigger", "test", String(seq)),
    source: "test",
    kind: "test.event",
    at: new Date(Date.UTC(2026, 10, 11, 9, 0, seq)).toISOString(),
    threads: [`resource:test:thread-${seq}`],
    payload: { seq },
  };
}

function source(perPoll: number): Source {
  let seq = 0;
  return {
    id: "test",
    scope: "test source",
    async read() {
      const triggers = Array.from({ length: perPoll }, () => trigger(++seq));
      return { triggers, cursor: String(seq) };
    },
  };
}

describe("Source runner dispatch backlog", () => {
  it("keeps the newest Triggers when dispatch keeps failing", async () => {
    const batches: string[][] = [];
    const errors: Array<{ source: string; error: unknown }> = [];
    const runner = createSourceRunner({
      sources: [source(2)],
      store: createTriggerStore({}),
      maxPendingDispatch: 3,
      onTriggers: async (triggers) => {
        batches.push(triggers.map((item) => item.id));
        throw new Error("downstream unavailable");
      },
      onError: (sourceId, error) => errors.push({ source: sourceId, error }),
    });

    await runner.pollOnce();
    await runner.pollOnce();
    await runner.pollOnce();

    expect(batches.map((batch) => batch.length)).toEqual([2, 3, 3]);
    expect(new Set(batches[2]).size).toBe(3);
    expect(
      errors.some(
        (row) =>
          row.source === "dispatch" &&
          row.error instanceof Error &&
          row.error.message.includes("backlog exceeded 3")
      )
    ).toBe(true);
  });

  it("rejects a backlog limit that cannot hold a Trigger", () => {
    expect(() =>
      createSourceRunner({
        sources: [],
        store: createTriggerStore({}),
        maxPendingDispatch: 0,
      })
    ).toThrow("maxPendingDispatch must be a positive integer");
  });
});
