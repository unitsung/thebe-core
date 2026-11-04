import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createOpenApiDocument } from "./openapi.ts";

const ORIGIN = "http://127.0.0.1:8787";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

type Item = Record<string, any>;

const provider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => {
    throw new Error("unused");
  },
  getStatusSummary: async () => {
    throw new Error("unused");
  },
};

/** An app whose clock and schedule timer the test drives by hand, so nothing waits. */
async function setup(options: { storedSchedules?: unknown[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "thebe-schedule-modes-"));
  dirs.push(dir);
  if (options.storedSchedules) {
    await mkdir(join(dir, "schedules"), { recursive: true });
    await writeFile(
      join(dir, "schedules", "schedules.json"),
      JSON.stringify(options.storedSchedules)
    );
  }
  const world = { now: new Date("2026-11-05T08:00:00Z") };
  const fake = createFakeRuntime();
  fake.queueTurns([
    { kind: "text", text: "Completed" },
    { kind: "text", text: "VERDICT: pass\nEVIDENCE: Checked\nREMAINING: none" },
    { kind: "text", text: "Completed" },
    { kind: "text", text: "VERDICT: pass\nEVIDENCE: Checked\nREMAINING: none" },
  ]);
  let tick: (() => Promise<void>) | undefined;
  const app = createThebeApp({
    runtime: fake.runtime,
    provider,
    agentStoreDir: dir,
    now: () => world.now,
    schedules: {
      timer: (callback) => {
        tick = callback;
        return () => {
          tick = undefined;
        };
      },
    },
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await app.handler.handle(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
    return { status: response.status, body: (await response.json()) as Item };
  };
  const dueAt = async (iso: string) => {
    world.now = new Date(iso);
    if (!tick) throw new Error("the scheduler did not start its timer");
    await tick();
  };
  const records = async () =>
    (await call("/v1/activity?source=schedule_observation")).body
      .items as Item[];
  const goals = async () => (await app.agent.listGoals()).length;
  /** Lets every started Goal finish, so nothing is still writing when the test's directory goes. */
  const settle = async () => {
    for (const goal of await app.agent.listGoals())
      await app.agent.waitGoal(goal.thebeSessionId);
  };
  const sessions = async () => (await app.agent.listSessions()).length;
  return { app, call, dueAt, records, goals, settle, sessions, dir, world };
}

const base = {
  title: "Nightly check",
  goal: "Check that every container is healthy",
  maxIterations: 3,
  startAt: "2026-11-05T09:00:00Z",
  intervalMinutes: 60,
};

describe("schedule accept modes", () => {
  it("observes a new schedule: at its due time only a record exists, with its time, goal and scope", async () => {
    const f = await setup();
    const criteria = ["Every container is running"];
    const created = await f.call("/v1/schedules", "POST", {
      ...base,
      criteria,
    });
    expect(created.status).toBe(201);
    expect(created.body.mode).toBe("observe");

    await f.dueAt("2026-11-05T09:00:30Z");

    expect(await f.goals()).toBe(0);
    expect(await f.sessions()).toBe(0);
    expect(await f.app.agent.listPendingPermissions()).toEqual([]);
    expect(await f.app.agent.listActivity()).toEqual([]);
    const items = await f.records();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "schedule_observation",
      group: "recent",
      stage: { kind: "ended" },
      observation: {
        scheduleId: created.body.id,
        title: "Nightly check",
        goal: base.goal,
        dueAt: "2026-11-05T09:00:00.000Z",
        observedAt: "2026-11-05T09:00:30.000Z",
        scope: { criteria, maxIterations: 3 },
        scheduleMode: "observe",
      },
    });
    // A record is not something the person must act on: it adds nothing to needs-you.
    expect((await f.call("/v1/activity/summary")).body.needsYou.count).toBe(0);
    // The same occurrence is never recorded twice.
    await f.dueAt("2026-11-05T09:00:40Z");
    expect(await f.records()).toHaveLength(1);
    // The schedule still moves on to its next occurrence.
    expect(
      (await f.call(`/v1/schedules/${created.body.id}`)).body
    ).toMatchObject({ mode: "observe", nextRunAt: "2026-11-05T10:00:00.000Z" });
    // The record opens by its id.
    const detail = await f.call(`/v1/activity/${items[0]!.id}`);
    expect(detail.body.type).toBe("schedule_observation");
  });

  it("runs once from the record: exactly one run, and the schedule stays in observe", async () => {
    const f = await setup();
    const created = await f.call("/v1/schedules", "POST", base);
    await f.dueAt("2026-11-05T09:00:30Z");

    const run = await f.call(`/v1/schedules/${created.body.id}/run`, "POST");
    expect(run.status).toBe(200);
    expect(await f.goals()).toBe(1);
    await f.app.agent.waitGoal(run.body.lastSessionId);
    expect(run.body.mode).toBe("observe");
    expect(await f.goals()).toBe(1);
  });

  it("switches to auto: the next due time runs once", async () => {
    const f = await setup();
    const created = await f.call("/v1/schedules", "POST", base);
    await f.dueAt("2026-11-05T09:00:30Z");
    expect(await f.goals()).toBe(0);

    const switched = await f.call(`/v1/schedules/${created.body.id}`, "PATCH", {
      mode: "auto",
    });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({
      mode: "auto",
      enabled: true,
      nextRunAt: "2026-11-05T10:00:00.000Z",
    });
    // Switching starts nothing by itself, and the old record now offers no switch.
    expect(await f.goals()).toBe(0);
    expect((await f.records())[0]!.observation.scheduleMode).toBe("auto");

    await f.dueAt("2026-11-05T10:00:05Z");
    await f.dueAt("2026-11-05T10:00:06Z");
    expect(await f.goals()).toBe(1);
    expect(await f.records()).toHaveLength(1);
    await f.settle();
  });

  it("does nothing at all in off mode", async () => {
    const f = await setup();
    await f.call("/v1/schedules", "POST", { ...base, mode: "off" });
    await f.dueAt("2026-11-05T09:00:30Z");
    expect(await f.goals()).toBe(0);
    expect(await f.sessions()).toBe(0);
    expect(await f.records()).toEqual([]);
  });

  it("keeps an existing schedule on auto", async () => {
    const f = await setup({
      storedSchedules: [
        {
          id: "old-1",
          title: "Old",
          goal: "Check things",
          startAt: "2026-11-05T09:00:00.000Z",
          nextRunAt: "2026-11-05T09:00:00.000Z",
          enabled: true,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    expect((await f.call("/v1/schedules/old-1")).body.mode).toBe("auto");
    await f.dueAt("2026-11-05T09:00:30Z");
    expect(await f.goals()).toBe(1);
    expect(await f.records()).toEqual([]);
    await f.settle();
  });

  it("deletes a schedule and its records but not the goals it already produced", async () => {
    const f = await setup();
    const created = await f.call("/v1/schedules", "POST", base);
    await f.dueAt("2026-11-05T09:00:30Z");
    const run = await f.call(`/v1/schedules/${created.body.id}/run`, "POST");
    await f.app.agent.waitGoal(run.body.lastSessionId);
    expect(await f.records()).toHaveLength(1);

    expect(
      (await f.call(`/v1/schedules/${created.body.id}`, "DELETE")).status
    ).toBe(200);
    expect(await f.records()).toEqual([]);
    expect(await f.goals()).toBe(1);
  });

  it("keeps the mode when a schedule is edited without one, and validates it", async () => {
    const f = await setup();
    const created = await f.call("/v1/schedules", "POST", {
      ...base,
      mode: "auto",
    });
    const edited = await f.call(`/v1/schedules/${created.body.id}`, "PUT", {
      ...base,
      title: "Renamed",
    });
    expect(edited.body).toMatchObject({ title: "Renamed", mode: "auto" });
    const moved = await f.call(`/v1/schedules/${created.body.id}`, "PUT", {
      ...base,
      mode: "observe",
    });
    expect(moved.body.mode).toBe("observe");

    expect(
      (await f.call("/v1/schedules", "POST", { ...base, mode: "sometimes" }))
        .status
    ).toBe(400);
    expect(
      (await f.call(`/v1/schedules/${created.body.id}`, "PATCH", { mode: "x" }))
        .status
    ).toBe(400);
    expect(
      (await f.call(`/v1/schedules/${created.body.id}`, "PATCH", {})).status
    ).toBe(400);
    // The pause switch still works on its own.
    const paused = await f.call(`/v1/schedules/${created.body.id}`, "PATCH", {
      enabled: false,
    });
    expect(paused.body).toMatchObject({ enabled: false, mode: "observe" });
  });

  it("documents the mode and the record in the OpenAPI document", () => {
    const document = createOpenApiDocument("test");
    expect(document.components.schemas.ScheduleObservation).toBeDefined();
    expect(
      document.components.schemas.ActivityScheduleObservationItem
    ).toBeDefined();
    expect(
      (document.components.schemas.GoalScheduleInput as any).properties.mode
    ).toBeDefined();
  });
});
