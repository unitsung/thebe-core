import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerInfoProvider,
  ContainerSummary,
} from "../../agent/capabilities/containers.ts";
import type { Trigger } from "../../agent/sources/types.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

const ORIGIN = "http://127.0.0.1:8787";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** Local time on 5 November 2026, so quiet hours do not depend on the machine's time zone. */
const at = (hour: number, minute = 0) => new Date(2026, 10, 5, hour, minute);

const emby = (status: string, state: ContainerSummary["state"] = "running") =>
  ({
    id: "ctr-emby",
    name: "/emby",
    image: "emby/embyserver:4.8",
    state,
    status,
    created: 1,
  }) satisfies ContainerSummary;

type Item = Record<string, any>;

/**
 * A fake container provider and a clock the test moves by hand. The poll loop's timer is replaced by a
 * function the test calls, so nothing waits.
 */
function setup(
  options: { dir?: string; sources?: Record<string, unknown> } = {}
) {
  const world = {
    now: at(12),
    containers: [emby("Up 3 hours (healthy)")] as ContainerSummary[],
    failReads: false,
    reads: 0,
  };
  const provider: ContainerInfoProvider = {
    listContainers: async () => {
      world.reads += 1;
      if (world.failReads) throw new Error("docker socket unreachable");
      return world.containers;
    },
    inspectContainer: async () => {
      throw new Error("inspect not used");
    },
    getContainerLogs: async () => {
      throw new Error("logs not used");
    },
    getStatusSummary: async () => {
      throw new Error("summary not used");
    },
  };
  const evaluated: Trigger[] = [];
  let tick: (() => Promise<void>) | undefined;
  const app = createThebeApp({
    runtime: createFakeRuntime().runtime,
    provider,
    agentStoreDir: options.dir,
    now: () => world.now,
    sources: {
      evaluate: async (trigger) => {
        evaluated.push(trigger);
      },
      timer: (callback) => {
        tick = callback;
        return () => {
          tick = undefined;
        };
      },
    },
  });
  const call = async (path: string, init?: RequestInit) =>
    (await (
      await app.handler.handle(new Request(`${ORIGIN}${path}`, init))
    ).json()) as Item;
  const configure = async (
    source: Record<string, unknown> = { enabled: true }
  ) => {
    const policy = await call("/v1/policy");
    await call("/v1/policy", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseVersion: policy.version,
        sources: { "container-health": source },
      }),
    });
  };
  const poll = async () => {
    if (!tick) throw new Error("the source runtime did not start its timer");
    await tick();
  };
  /** Oldest first: the source numbers its Triggers, and the id ends with that number. */
  const sequence = (item: Item) => Number(item.id.split(":").at(-1));
  const triggers = async () =>
    ((await call("/v1/activity?source=trigger")).items as Item[]).sort(
      (a, b) => sequence(a) - sequence(b)
    );
  return { app, world, call, configure, poll, triggers, evaluated };
}

describe("container-health source through the Gate", () => {
  it("turns one unhealthy container into one Trigger and one Gate outcome in Activity", async () => {
    const { world, configure, poll, triggers, evaluated } = setup();
    await configure();
    await poll();
    expect(await triggers()).toEqual([]);

    world.containers = [emby("Up 3 hours (unhealthy)")];
    world.now = at(12, 5);
    await poll();
    await poll();

    const items = await triggers();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "trigger",
      group: "recent",
      stage: { kind: "ended" },
      trigger: {
        trigger: {
          source: "container-health",
          kind: "unhealthy",
          severity: "warning",
          thread: { kind: "container", id: "ctr-emby", name: "emby" },
        },
        outcome: { result: "passed" },
      },
    });
    expect(evaluated.map((trigger) => trigger.id)).toEqual([
      items[0]!.trigger.trigger.id,
    ]);
  });
  it("records a repeat of the same kind on the same container as a duplicate and starts no second evaluation", async () => {
    const { world, configure, poll, triggers, evaluated } = setup();
    await configure();
    await poll();
    world.containers = [emby("Up 3 hours (unhealthy)")];
    world.now = at(12, 5);
    await poll();
    // It recovers and turns unhealthy again ten minutes later, inside the 30 minute window.
    world.containers = [emby("Up 3 hours (healthy)")];
    world.now = at(12, 10);
    await poll();
    world.containers = [emby("Up 3 hours (unhealthy)")];
    world.now = at(12, 15);
    await poll();

    const outcomes = (await triggers()).map((item) => [
      item.trigger.trigger.kind,
      item.trigger.outcome,
    ]);
    const first = (await triggers()).find(
      (item) => item.trigger.outcome.result === "passed"
    )!;
    expect(outcomes).toEqual([
      ["unhealthy", { result: "passed" }],
      ["recovered", { result: "filtered", reason: "severity" }],
      [
        "unhealthy",
        {
          result: "duplicate",
          reason: "duplicate",
          duplicateOf: first.trigger.trigger.id,
        },
      ],
    ]);
    expect(evaluated).toHaveLength(1);
  });

  it("evaluates a new problem after the de-duplication window has passed", async () => {
    const { world, configure, poll, evaluated } = setup();
    await configure();
    await poll();
    world.containers = [emby("Up 3 hours (unhealthy)")];
    await poll();
    world.containers = [emby("Up 3 hours (healthy)")];
    await poll();
    world.containers = [emby("Up 3 hours (unhealthy)")];
    world.now = at(13, 0);
    await poll();
    expect(evaluated).toHaveLength(2);
  });

  it("resumes from its saved position after a restart without replaying", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-sources-"));
    dirs.push(dir);
    const before = setup({ dir });
    await before.configure();
    await before.poll();
    before.world.containers = [emby("Up 3 hours (unhealthy)")];
    await before.poll();
    expect(await before.triggers()).toHaveLength(1);

    // A new process over the same store; the container is still unhealthy: nothing is replayed.
    const after = setup({ dir });
    after.world.containers = [emby("Up 3 hours (unhealthy)")];
    await after.poll();
    expect(await after.triggers()).toHaveLength(1);
    expect(after.evaluated).toEqual([]);

    // Changes that happened while Core was down are not lost: the saved position says what was last seen.
    const later = setup({ dir });
    later.world.containers = [emby("Up 3 hours (healthy)")];
    later.world.now = at(12, 30);
    await later.poll();
    later.world.containers = [emby("Exited (137) 2 minutes ago", "exited")];
    later.world.now = at(12, 40);
    await later.poll();
    const kinds = (await later.triggers()).map(
      (item) => item.trigger.trigger.kind
    );
    expect(kinds).toEqual(["unhealthy", "recovered", "down"]);
    expect(later.evaluated.map((trigger) => trigger.kind)).toEqual(["down"]);
  });

  it("filters events during quiet hours or below the configured severity, with the reason", async () => {
    const { world, configure, poll, triggers } = setup();
    await configure({
      enabled: true,
      minSeverity: "critical",
      quietHours: null,
    });
    await poll();
    world.containers = [emby("Up 3 hours (unhealthy)")];
    await poll();
    expect((await triggers()).map((item) => item.trigger.outcome)).toEqual([
      { result: "filtered", reason: "severity" },
    ]);

    // Quiet hours hold a warning back at night, but a crash breaks through.
    await configure({ enabled: true, minSeverity: "info" });
    world.containers = [emby("Up 3 hours (healthy)")];
    world.now = at(23, 30);
    await poll();
    world.containers = [emby("Up 3 hours (unhealthy)")];
    world.now = at(23, 40);
    await poll();
    world.containers = [emby("Exited (1) 1 minute ago", "exited")];
    world.now = at(23, 50);
    await poll();
    const results = (await triggers())
      .filter((item) => item.trigger.trigger.observedAt >= at(23).toISOString())
      .map((item) => [
        item.trigger.trigger.kind,
        item.trigger.outcome.result,
        item.trigger.outcome.reason,
      ]);
    expect(results).toEqual([
      ["recovered", "filtered", "quiet_hours"],
      ["unhealthy", "filtered", "quiet_hours"],
      ["down", "passed", undefined],
    ]);
  });

  it("does not read or record anything while the source is off", async () => {
    const { world, call, poll, triggers } = setup();
    world.containers = [emby("Up 3 hours (unhealthy)")];
    await poll();
    expect(world.reads).toBe(0);
    expect(await triggers()).toEqual([]);
    expect(
      (await call("/v1/health")).sources["container-health"]
    ).toMatchObject({
      enabled: false,
      failing: false,
    });
  });

  it("shows ten minutes of read failures in health and makes no Trigger", async () => {
    const { world, call, configure, poll, triggers, evaluated } = setup();
    await configure();
    await poll();
    world.failReads = true;
    world.now = at(12, 1);
    await poll();
    world.now = at(12, 6);
    await poll();
    let source = (await call("/v1/health")).sources["container-health"];
    expect(source).toMatchObject({
      enabled: true,
      consecutiveFailures: 2,
      failingSince: at(12, 1).toISOString(),
      failing: false,
    });

    world.now = at(12, 11);
    await poll();
    source = (await call("/v1/health")).sources["container-health"];
    expect(source).toMatchObject({ consecutiveFailures: 3, failing: true });
    expect(source.lastError).toContain("docker socket unreachable");
    expect(await triggers()).toEqual([]);
    expect(evaluated).toEqual([]);

    world.failReads = false;
    await poll();
    source = (await call("/v1/health")).sources["container-health"];
    expect(source).toMatchObject({ consecutiveFailures: 0, failing: false });
  });

  it("runs at most one evaluation per container at a time", async () => {
    const world = { containers: [emby("Up 1 hour (healthy)")] };
    const gates: Array<() => void> = [];
    const started: string[] = [];
    let tick!: () => Promise<void>;
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: {
        listContainers: async () => world.containers,
        inspectContainer: async () => {
          throw new Error("unused");
        },
        getContainerLogs: async () => "",
        getStatusSummary: async () => {
          throw new Error("unused");
        },
      },
      now: () => at(12),
      sources: {
        evaluate: (trigger) =>
          new Promise<void>((resolve) => {
            started.push(trigger.kind);
            gates.push(resolve);
          }),
        timer: (callback) => {
          tick = callback;
          return () => undefined;
        },
      },
    });
    const policy = (await (
      await app.handler.handle(new Request(`${ORIGIN}/v1/policy`))
    ).json()) as Item;
    await app.handler.handle(
      new Request(`${ORIGIN}/v1/policy`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseVersion: policy.version,
          sources: { "container-health": { enabled: true } },
        }),
      })
    );
    await tick();
    world.containers = [emby("Up 1 hour (unhealthy)")];
    await tick();
    world.containers = [emby("Exited (1) now", "exited")];
    await tick();
    await Promise.resolve();
    expect(started).toEqual(["unhealthy"]);

    gates[0]!();
    await vi.waitFor(() => expect(started).toEqual(["unhealthy", "down"]));
  });
});
