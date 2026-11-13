import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

const AT = "2026-11-12T20:00:00.000Z";
const fixedNow = () => new Date(AT);

function triggerFor(source: string, seq: number): Trigger {
  return {
    id: key("trigger", source, String(seq)),
    source,
    kind: "test.event",
    at: new Date(Date.UTC(2026, 10, 11, 9, 0, seq)).toISOString(),
    threads: [`resource:test:${source}-${seq}`],
    payload: { seq },
  };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

describe("Source runner concurrency", () => {
  it("commits a fast Source while a slow Source is still reading", async () => {
    const slowStarted = gate();
    const releaseSlow = gate();
    let fastReads = 0;
    const slow: Source = {
      id: "slow",
      scope: "slow source",
      async read() {
        slowStarted.open();
        await releaseSlow.promise;
        return { triggers: [], cursor: "slow-1" };
      },
    };
    const fast: Source = {
      id: "fast",
      scope: "fast source",
      async read() {
        fastReads += 1;
        return { triggers: [triggerFor("fast", 1)], cursor: "fast-1" };
      },
    };
    const store = createTriggerStore({});
    const dispatched: Trigger[] = [];
    const runner = createSourceRunner({
      sources: [slow, fast],
      store,
      now: fixedNow,
      onTriggers: (items) => {
        dispatched.push(...items);
      },
    });

    const polling = runner.pollOnce();
    try {
      await slowStarted.promise;
      await vi.waitFor(async () => {
        expect(fastReads).toBe(1);
        expect(await store.cursor("fast")).toBe("fast-1");
      });
      expect((await store.list()).map((item) => item.source)).toEqual(["fast"]);
      // The fast Trigger is durable, but dispatch still waits for the whole poll.
      expect(dispatched).toEqual([]);
      expect(runner.health()).toEqual([
        {
          id: "slow",
          scope: "slow source",
          state: "starting",
          consecutiveFailures: 0,
        },
        {
          id: "fast",
          scope: "fast source",
          state: "healthy",
          consecutiveFailures: 0,
          lastAttemptAt: AT,
          lastSuccessAt: AT,
        },
      ]);
    } finally {
      releaseSlow.open();
    }

    await polling;
    expect(await store.cursor("slow")).toBe("slow-1");
    expect(dispatched.map((item) => item.source)).toEqual(["fast"]);
    expect(runner.health()).toEqual([
      {
        id: "slow",
        scope: "slow source",
        state: "healthy",
        consecutiveFailures: 0,
        lastAttemptAt: AT,
        lastSuccessAt: AT,
      },
      {
        id: "fast",
        scope: "fast source",
        state: "healthy",
        consecutiveFailures: 0,
        lastAttemptAt: AT,
        lastSuccessAt: AT,
      },
    ]);
  });

  it("keeps each Source's health and timestamps independent when one fails", async () => {
    const good: Source = {
      id: "good",
      scope: "good source",
      async read() {
        return { triggers: [triggerFor("good", 1)], cursor: "good-1" };
      },
    };
    const bad: Source = {
      id: "bad",
      scope: "bad source",
      async read() {
        throw new Error("provider down");
      },
    };
    const errors: string[] = [];
    const runner = createSourceRunner({
      sources: [bad, good],
      store: createTriggerStore({}),
      now: fixedNow,
      onError: (id) => errors.push(id),
    });

    expect(await runner.pollOnce()).toEqual([triggerFor("good", 1)]);
    expect(errors).toEqual(["bad"]);
    expect(runner.health()).toEqual([
      {
        id: "bad",
        scope: "bad source",
        state: "failing",
        consecutiveFailures: 1,
        lastAttemptAt: AT,
        lastFailureAt: AT,
        lastError: "provider down",
      },
      {
        id: "good",
        scope: "good source",
        state: "healthy",
        consecutiveFailures: 0,
        lastAttemptAt: AT,
        lastSuccessAt: AT,
      },
    ]);

    await runner.pollOnce();
    expect(runner.health()[0]).toMatchObject({
      id: "bad",
      state: "failing",
      consecutiveFailures: 2,
      lastError: "provider down",
    });
    expect(runner.health()[1]).toMatchObject({
      id: "good",
      state: "healthy",
      consecutiveFailures: 0,
    });
  });

  it("shares one in-flight poll across overlapping calls", async () => {
    const gates = [gate(), gate()];
    let reads = 0;
    const make = (id: string, index: number): Source => ({
      id,
      scope: id,
      async read() {
        reads += 1;
        await gates[index]!.promise;
        return { triggers: [], cursor: `${id}-1` };
      },
    });
    const store = createTriggerStore({});
    const runner = createSourceRunner({
      sources: [make("one", 0), make("two", 1)],
      store,
      now: fixedNow,
    });

    const polling = runner.pollOnce();
    const overlapping = runner.pollOnce();
    await vi.waitFor(() => expect(reads).toBe(2));
    gates.forEach((current) => current.open());
    await Promise.all([polling, overlapping]);

    expect(reads).toBe(2);
    expect(await store.cursor("one")).toBe("one-1");
    expect(await store.cursor("two")).toBe("two-1");
  });

  it("aborts every in-flight read on quiesce and discards both results", async () => {
    const store = createTriggerStore({});
    const started = [gate(), gate()];
    const results = [
      deferred<{ triggers: Trigger[]; cursor: string }>(),
      deferred<{ triggers: Trigger[]; cursor: string }>(),
    ];
    const signals: AbortSignal[] = [];
    const make = (id: string, index: number): Source => ({
      id,
      scope: id,
      read(_cursor, signal) {
        signals.push(signal as AbortSignal);
        started[index]!.open();
        return results[index]!.promise;
      },
    });
    const runner = createSourceRunner({
      sources: [make("slow-a", 0), make("slow-b", 1)],
      store,
    });

    const polling = runner.pollOnce();
    await Promise.all(started.map((current) => current.promise));
    expect(signals).toHaveLength(2);

    const stopping = runner.stop();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    results[0]!.resolve({
      triggers: [triggerFor("slow-a", 1)],
      cursor: "slow-a-1",
    });
    results[1]!.resolve({
      triggers: [triggerFor("slow-b", 1)],
      cursor: "slow-b-1",
    });
    await Promise.all([polling, stopping]);

    expect(await store.list()).toEqual([]);
    expect(await store.cursor("slow-a")).toBeUndefined();
    expect(await store.cursor("slow-b")).toBeUndefined();
    expect(runner.health().map((row) => row.state)).toEqual([
      "starting",
      "starting",
    ]);
  });

  it("does not let a Source that ignores the signal hold quiesce open", async () => {
    const store = createTriggerStore({});
    const started = gate();
    const runner = createSourceRunner({
      sources: [
        {
          id: "stuck",
          scope: "stuck source",
          read: () => {
            started.open();
            return new Promise(() => {});
          },
        },
      ],
      store,
      now: fixedNow,
    });

    void runner.pollOnce();
    await started.promise;
    const stopping = runner.stop();
    const outcome = await Promise.race([
      stopping.then(() => "stopped"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timeout"), 200)
      ),
    ]);
    expect(outcome).toBe("stopped");
    expect(await store.list()).toEqual([]);
  });

  it("restores each persisted cursor after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-sources-concurrent-"));
    const seen: Record<string, Array<string | undefined>> = {
      alpha: [],
      beta: [],
    };
    const make = (id: string, cursor: string): Source => ({
      id,
      scope: id,
      async read(before) {
        seen[id]!.push(before);
        return {
          triggers: before ? [] : [triggerFor(id, 1)],
          cursor,
        };
      },
    });

    const first = createSourceRunner({
      sources: [make("alpha", "alpha-1"), make("beta", "beta-1")],
      store: createTriggerStore({ dir }),
      now: fixedNow,
    });
    expect((await first.pollOnce()).map((item) => item.source).sort()).toEqual([
      "alpha",
      "beta",
    ]);

    const restarted = createSourceRunner({
      sources: [make("alpha", "alpha-1"), make("beta", "beta-1")],
      store: createTriggerStore({ dir }),
      now: fixedNow,
    });
    expect(await restarted.pollOnce()).toEqual([]);
    expect(seen).toEqual({
      alpha: [undefined, "alpha-1"],
      beta: [undefined, "beta-1"],
    });

    const reopened = createTriggerStore({ dir });
    expect(await reopened.cursor("alpha")).toBe("alpha-1");
    expect(await reopened.cursor("beta")).toBe("beta-1");
    expect(await reopened.list()).toHaveLength(2);
  });

  it("serializes concurrent Trigger and cursor writes without losing an entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-sources-store-"));
    const store = createTriggerStore({ dir });
    const alpha = triggerFor("alpha", 1);
    const beta = triggerFor("beta", 1);

    await Promise.all([
      store.add([alpha]),
      store.add([beta]),
      store.setCursor("alpha", "alpha-1"),
      store.setCursor("beta", "beta-1"),
    ]);

    const reopened = createTriggerStore({ dir });
    expect(await reopened.cursor("alpha")).toBe("alpha-1");
    expect(await reopened.cursor("beta")).toBe("beta-1");
    expect((await reopened.list()).map((item) => item.id).sort()).toEqual(
      [alpha.id, beta.id].sort()
    );
  });
});
