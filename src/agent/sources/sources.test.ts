import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ContainerHealth,
  ContainerInfoProvider,
  ContainerState,
} from "../capabilities/containers.ts";
import { createContainerHealthSource } from "./container-health.ts";
import { createDownloadCompletedSource } from "./download-completed.ts";
import { createSourceRunner } from "./runner.ts";
import { createTriggerStore } from "./store.ts";
import type { Source, Trigger } from "./types.ts";
import type {
  DownloadItem,
  DownloadProvider,
} from "../capabilities/pipeline.ts";

function docker(
  initial: Record<string, ContainerState>,
  initialHealth: Record<string, ContainerHealth> = {}
) {
  const states = { ...initial };
  const health = { ...initialHealth };
  const provider = {
    listContainers: async () =>
      Object.entries(states).map(([name, state]) => ({
        id: `id-${name}`,
        name,
        image: "img",
        state,
        ...(health[name] ? { health: health[name] } : {}),
        status: state,
        created: 1,
      })),
  } as unknown as ContainerInfoProvider;
  return { provider, states, health };
}

const clock = () => {
  let t = Date.parse("2026-11-06T10:00:00Z");
  return () => new Date((t += 1000));
};

describe("container-health source", () => {
  it("takes a baseline on its first read and reports nothing, even if something is already down", async () => {
    const { provider } = docker(
      { emby: "exited", jellyfin: "running" },
      { jellyfin: "unhealthy" }
    );
    const source = createContainerHealthSource({ provider, now: clock() });
    const first = await source.read(undefined);
    expect(first.triggers).toEqual([]);
    expect((await source.read(first.cursor)).triggers).toEqual([]);
  });

  it("reports a running container going down and recovering, on the container's own thread", async () => {
    const { provider, states } = docker({ emby: "running" });
    const source = createContainerHealthSource({ provider, now: clock() });
    let cursor = (await source.read(undefined)).cursor;

    states.emby = "exited";
    const down = await source.read(cursor);
    cursor = down.cursor;
    expect(down.triggers).toHaveLength(1);
    expect(down.triggers[0]).toMatchObject({
      source: "container-health",
      kind: "container.went_down",
      threads: ["resource:container:emby"],
      resource: { kind: "container", id: "emby" },
      payload: { from: "running", to: "exited" },
    });

    states.emby = "running";
    const up = await source.read(cursor);
    expect(up.triggers.map((t) => t.kind)).toEqual(["container.recovered"]);
  });

  it("reports an unhealthy running container once and when it becomes healthy again", async () => {
    const { provider, health } = docker(
      { emby: "running" },
      { emby: "healthy" }
    );
    const source = createContainerHealthSource({ provider, now: clock() });
    let cursor = (await source.read(undefined)).cursor;

    health.emby = "unhealthy";
    const unhealthy = await source.read(cursor);
    cursor = unhealthy.cursor;
    expect(unhealthy.triggers).toHaveLength(1);
    expect(unhealthy.triggers[0]).toMatchObject({
      kind: "container.unhealthy",
      threads: ["resource:container:emby"],
      resource: { kind: "container", id: "emby" },
      payload: {
        state: "running",
        health: { from: "healthy", to: "unhealthy" },
      },
    });
    expect((await source.read(cursor)).triggers).toEqual([]);

    health.emby = "starting";
    cursor = (await source.read(cursor)).cursor;
    health.emby = "healthy";
    const healthy = await source.read(cursor);
    expect(healthy.triggers.map((t) => t.kind)).toEqual([
      "container.recovered",
    ]);
  });

  it("seeds health for a cursor written before health was tracked", async () => {
    const { provider } = docker({ emby: "running" }, { emby: "unhealthy" });
    const source = createContainerHealthSource({ provider, now: clock() });
    const legacy = JSON.stringify({ n: 4, states: { emby: "running" } });
    const migrated = await source.read(legacy);
    expect(migrated.triggers).toEqual([]);
    expect((await source.read(migrated.cursor)).triggers).toEqual([]);
  });

  it("notes a container appearing or being removed, and other state changes", async () => {
    const { provider, states } = docker({ a: "running", b: "running" });
    const source = createContainerHealthSource({ provider, now: clock() });
    let cursor = (await source.read(undefined)).cursor;
    delete states.b;
    states.c = "running";
    states.a = "paused";
    const read = await source.read(cursor);
    expect(read.triggers.map((t) => [t.resource?.id, t.kind])).toEqual([
      ["a", "container.state_changed"],
      ["b", "container.removed"],
      ["c", "container.appeared"],
    ]);
  });

  it("gives each flip of a flapping container its own Trigger", async () => {
    const { provider, states } = docker({ emby: "running" });
    const source = createContainerHealthSource({ provider, now: clock() });
    let cursor = (await source.read(undefined)).cursor;
    const ids = new Set<string>();
    for (const next of [
      "exited",
      "running",
      "exited",
      "running",
      "exited",
    ] as const) {
      states.emby = next;
      const read = await source.read(cursor);
      cursor = read.cursor;
      for (const t of read.triggers) ids.add(t.id);
    }
    expect(ids.size).toBe(5);
  });

  it("re-reading the same change from the same cursor gives the same id", async () => {
    const { provider, states } = docker({ emby: "running" });
    const source = createContainerHealthSource({ provider, now: clock() });
    const baseline = (await source.read(undefined)).cursor;
    states.emby = "dead";
    const a = await source.read(baseline);
    const b = await source.read(baseline);
    expect(b.triggers[0]!.id).toBe(a.triggers[0]!.id);
  });

  it("treats an unreadable cursor as a fresh baseline instead of announcing everything", async () => {
    const { provider } = docker({ emby: "exited" });
    const source = createContainerHealthSource({ provider, now: clock() });
    expect((await source.read("{not json")).triggers).toEqual([]);
  });
});

function download(
  phase: DownloadItem["phase"],
  overrides: Partial<DownloadItem> = {}
): DownloadItem {
  return {
    hash: "a".repeat(40),
    name: "Example",
    engine: "qbittorrent",
    id: "a".repeat(40),
    phase,
    badges: [],
    capabilities: [],
    state:
      phase === "completed" ? "seeding" : phase === "queued" ? "queued" : phase,
    progress: phase === "completed" ? 1 : 0.5,
    ...overrides,
  };
}

function downloads(items: DownloadItem[]): DownloadProvider {
  return {
    service: "downloads",
    add: async () => ({ submitted: 0 }),
    list: async () => items.map((item) => ({ ...item })),
    get: async (hash) => items.find((item) => item.hash === hash),
  };
}

describe("download-completed source", () => {
  it("takes a baseline and reports a download entering completed once", async () => {
    const items = [download("downloading")];
    const source = createDownloadCompletedSource({
      downloads: downloads(items),
      now: clock(),
    });
    let cursor = (await source.read(undefined)).cursor;

    items[0] = download("completed", {
      completedAt: "2026-11-06T10:01:00.000Z",
      contentPath: "/downloads/Example",
      sizeBytes: 2048,
    });
    const completed = await source.read(cursor);
    cursor = completed.cursor;
    expect(completed.triggers).toHaveLength(1);
    expect(completed.triggers[0]).toMatchObject({
      source: "download-completed",
      kind: "download.completed",
      threads: [`resource:download:qbittorrent:${"a".repeat(40)}`],
      resource: {
        kind: "download",
        id: `qbittorrent:${"a".repeat(40)}`,
      },
      payload: {
        engine: "qbittorrent",
        hash: "a".repeat(40),
        from: "downloading",
        to: "completed",
        contentPath: "/downloads/Example",
      },
    });

    expect((await source.read(cursor)).triggers).toEqual([]);
  });

  it("does not announce completed downloads that were already there at startup", async () => {
    const source = createDownloadCompletedSource({
      downloads: downloads([download("completed")]),
      now: clock(),
    });
    const baseline = await source.read(undefined);
    expect(baseline.triggers).toEqual([]);
    expect((await source.read(baseline.cursor)).triggers).toEqual([]);
  });

  it("uses a stable id when the same transition is read from the same cursor", async () => {
    const items = [download("downloading")];
    const source = createDownloadCompletedSource({
      downloads: downloads(items),
      now: clock(),
    });
    const baseline = await source.read(undefined);
    items[0] = download("completed", {
      completedAt: "2026-11-06T10:01:00.000Z",
    });
    const first = await source.read(baseline.cursor);
    const again = await source.read(baseline.cursor);
    expect(again.triggers[0]?.id).toBe(first.triggers[0]?.id);
  });

  it("fails the read instead of advancing a partial multi-engine cursor", async () => {
    const provider: DownloadProvider = {
      ...downloads([download("downloading")]),
      listWithProblems: async () => ({
        downloads: [download("completed")],
        unreachable: ["aria2: offline"],
      }),
    };
    const source = createDownloadCompletedSource({
      downloads: provider,
      now: clock(),
    });
    await expect(source.read(undefined)).rejects.toThrow(
      "partial download listing"
    );
  });
});

describe("runner", () => {
  it("stores each Trigger once and does not replay after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-sources-"));
    const { provider, states } = docker({ emby: "running" });
    const make = () =>
      createSourceRunner({
        sources: [createContainerHealthSource({ provider, now: clock() })],
        store: createTriggerStore({ dir }),
      });

    const first = make();
    await first.pollOnce(); // baseline
    states.emby = "exited";
    expect((await first.pollOnce()).map((t) => t.kind)).toEqual([
      "container.went_down",
    ]);

    const restarted = make();
    expect(await restarted.pollOnce()).toEqual([]);
    expect(await createTriggerStore({ dir }).list()).toHaveLength(1);
  });

  it("does not move the cursor when storing fails, so the change is read again", async () => {
    const { provider, states } = docker({ emby: "running" });
    const store = createTriggerStore({});
    const source = createContainerHealthSource({ provider, now: clock() });
    await createSourceRunner({ sources: [source], store }).pollOnce(); // baseline
    states.emby = "exited";

    let failures = 1;
    const flaky = {
      ...store,
      add: async (triggers: Parameters<typeof store.add>[0]) => {
        if (failures-- > 0) throw new Error("disk full");
        return store.add(triggers);
      },
    };
    const runner = createSourceRunner({
      sources: [source],
      store: flaky,
      onError: () => {},
    });
    expect(await runner.pollOnce()).toEqual([]); // storing failed
    expect((await runner.pollOnce()).map((t) => t.kind)).toEqual([
      "container.went_down",
    ]);
  });

  it("keeps going when one Source fails, and reports which", async () => {
    const bad: Source = {
      id: "bad",
      scope: "x",
      read: async () => {
        throw new Error("boom");
      },
    };
    const good: Source = {
      id: "good",
      scope: "x",
      read: async () => ({
        cursor: "1",
        triggers: [
          {
            id: "a".repeat(32),
            source: "good",
            kind: "k",
            at: "2026-11-06T10:00:00Z",
            threads: ["t"],
            payload: {},
          },
        ],
      }),
    };
    const errors: string[] = [];
    const runner = createSourceRunner({
      sources: [bad, good],
      store: createTriggerStore({}),
      onError: (id) => errors.push(id),
    });
    expect((await runner.pollOnce()).map((t) => t.source)).toEqual(["good"]);
    expect(errors).toEqual(["bad"]);
  });

  it("rejects provenance that does not belong to the Source before storing or advancing its cursor", async () => {
    const store = createTriggerStore({});
    let valid = false;
    const source: Source = {
      id: "external-chat",
      scope: "one external conversation",
      read: async () => ({
        cursor: "next",
        triggers: [
          {
            id: "b".repeat(32),
            source: "external-chat",
            kind: "message.created",
            at: "2026-11-06T10:00:00.000Z",
            threads: ["conversation:42"],
            payload: { text: "please inspect this" },
            actor: {
              source: valid ? "external-chat" : "other-source",
              id: "person-7",
            },
            human: true,
            channel: {
              source: "external-chat",
              thread: valid ? "conversation:42" : "conversation:other",
              address: { conversationId: "42" },
            },
          },
        ],
      }),
    };
    const runner = createSourceRunner({ sources: [source], store });

    expect(await runner.pollOnce()).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(await store.cursor(source.id)).toBeUndefined();
    expect(runner.health()[0]).toMatchObject({
      state: "failing",
      consecutiveFailures: 1,
    });

    valid = true;
    expect(await runner.pollOnce()).toHaveLength(1);
    expect(await store.cursor(source.id)).toBe("next");
    expect(runner.health()[0]).toMatchObject({
      state: "healthy",
      consecutiveFailures: 0,
    });
  });

  it("counts consecutive failures and clears them on a successful read", async () => {
    let failing = true;
    const source: Source = {
      id: "flaky",
      scope: "test source",
      read: async () => {
        if (failing) throw new Error("provider unavailable");
        return { cursor: "ok", triggers: [] };
      },
    };
    const runner = createSourceRunner({
      sources: [source],
      store: createTriggerStore({}),
      now: clock(),
    });
    expect(runner.health()).toEqual([
      {
        id: "flaky",
        scope: "test source",
        state: "starting",
        consecutiveFailures: 0,
      },
    ]);

    await runner.pollOnce();
    await runner.pollOnce();
    expect(runner.health()).toEqual([
      expect.objectContaining({
        id: "flaky",
        state: "failing",
        consecutiveFailures: 2,
        lastError: "provider unavailable",
      }),
    ]);

    failing = false;
    await runner.pollOnce();
    expect(runner.health()).toEqual([
      expect.objectContaining({
        id: "flaky",
        state: "healthy",
        consecutiveFailures: 0,
        lastSuccessAt: expect.any(String),
      }),
    ]);
    expect(runner.health()[0]).not.toHaveProperty("lastError");
  });

  it("does not overlap a slow read with the next tick, and stop() ends the timer", async () => {
    let reads = 0;
    let release!: () => void;
    const slow: Source = {
      id: "slow",
      scope: "x",
      read: () =>
        new Promise((resolve) => {
          reads += 1;
          release = () => resolve({ triggers: [], cursor: "c" });
        }),
    };
    const runner = createSourceRunner({
      sources: [slow],
      store: createTriggerStore({}),
    });
    const a = runner.pollOnce();
    const b = runner.pollOnce();
    await vi.waitFor(() => expect(reads).toBe(1));
    release();
    await Promise.all([a, b]);
    expect(reads).toBe(1);

    vi.useFakeTimers();
    try {
      const timed = createSourceRunner({
        sources: [
          {
            id: "t",
            scope: "x",
            read: async () => {
              reads += 1;
              return { triggers: [], cursor: "c" };
            },
          },
        ],
        store: createTriggerStore({}),
        intervalMs: 1000,
      });
      timed.start(); // reads once straight away
      await vi.advanceTimersByTimeAsync(0);
      timed.stop();
      const before = reads;
      await vi.advanceTimersByTimeAsync(5000);
      expect(reads).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an active read and waits without storing its cancelled result", async () => {
    const store = createTriggerStore({});
    const event: Trigger = {
      id: "d".repeat(32),
      source: "slow",
      kind: "message.created",
      at: "2026-11-06T10:00:00.000Z",
      threads: ["conversation:42"],
      payload: { text: "hello" },
    };
    let signal: AbortSignal | undefined;
    let release!: (result: { triggers: Trigger[]; cursor: string }) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const runner = createSourceRunner({
      sources: [
        {
          id: "slow",
          scope: "test source",
          read: (_cursor, readSignal) => {
            signal = readSignal;
            readStarted();
            return new Promise((resolve) => {
              release = resolve;
            });
          },
        },
      ],
      store,
    });

    const polling = runner.pollOnce();
    await started;
    const stopping = runner.stop();
    expect(signal?.aborted).toBe(true);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release({ triggers: [event], cursor: "offset-1" });
    await Promise.all([polling, stopping]);
    expect(await store.list()).toEqual([]);
    expect(await store.cursor("slow")).toBeUndefined();
  });

  it("waits for Trigger dispatch after its durable cursor commit", async () => {
    const store = createTriggerStore({});
    const event: Trigger = {
      id: "e".repeat(32),
      source: "dispatch",
      kind: "message.created",
      at: "2026-11-06T10:00:00.000Z",
      threads: ["conversation:42"],
      payload: { text: "hello" },
    };
    let finishDispatch!: () => void;
    let dispatchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const runner = createSourceRunner({
      sources: [
        {
          id: "dispatch",
          scope: "test source",
          read: async () => ({ triggers: [event], cursor: "offset-1" }),
        },
      ],
      store,
      onTriggers: async () => {
        dispatchStarted();
        await new Promise<void>((resolve) => {
          finishDispatch = resolve;
        });
      },
    });

    const polling = runner.pollOnce();
    await started;
    expect(await store.list()).toEqual([event]);
    expect(await store.cursor("dispatch")).toBe("offset-1");
    const stopping = runner.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishDispatch();
    await Promise.all([polling, stopping]);
    expect(stopped).toBe(true);
  });

  it("persists deterministic source-level admission with the Trigger", async () => {
    const event: Trigger = {
      id: "a".repeat(32),
      source: "admission-source",
      kind: "message.created",
      at: "2026-11-06T10:00:00.000Z",
      threads: ["conversation:42"],
      payload: { text: "Please inspect this" },
      actor: { source: "admission-source", id: "person-7" },
      human: true,
      addressed: "direct",
      channel: {
        source: "admission-source",
        thread: "conversation:42",
        address: { conversationId: "42" },
      },
    };
    const dispatched: Trigger[] = [];
    const store = createTriggerStore({});
    const runner = createSourceRunner({
      sources: [
        {
          id: "admission-source",
          scope: "one conversation",
          admit: (trigger) =>
            trigger.human && trigger.addressed === "direct"
              ? "explicit"
              : "ignore",
          read: async () => ({ triggers: [event], cursor: "offset-1" }),
        },
      ],
      store,
      onTriggers: (triggers) => {
        dispatched.push(...triggers);
      },
    });

    await runner.pollOnce();

    expect(await store.get(event.id)).toMatchObject({
      admission: "explicit",
      addressed: "direct",
      actor: event.actor,
      human: true,
      channel: event.channel,
    });
    expect(dispatched).toMatchObject([{ id: event.id, admission: "explicit" }]);
    await runner.stop();
  });

  it("retries a failed Trigger dispatch on the next poll", async () => {
    const event: Trigger = {
      id: "9".repeat(32),
      source: "retry-dispatch",
      kind: "message.created",
      at: "2026-11-06T10:00:00.000Z",
      threads: ["conversation:42"],
      payload: { text: "hello" },
    };
    let dispatches = 0;
    const delivered: Trigger[] = [];
    const errors: string[] = [];
    const runner = createSourceRunner({
      sources: [
        {
          id: "retry-dispatch",
          scope: "test source",
          read: async (cursor) => ({
            triggers: cursor ? [] : [event],
            cursor: "offset-1",
          }),
        },
      ],
      store: createTriggerStore({}),
      onTriggers: async (triggers) => {
        dispatches += 1;
        if (dispatches === 1) throw new Error("dispatch unavailable");
        delivered.push(...triggers);
      },
      onError: (source) => errors.push(source),
    });

    await runner.pollOnce();
    expect(errors).toEqual(["dispatch"]);
    expect(delivered).toEqual([]);
    await runner.pollOnce();
    expect(dispatches).toBe(2);
    expect(delivered).toEqual([event]);
    await runner.stop();
  });
});
