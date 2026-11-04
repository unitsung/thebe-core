import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import type { AgentSessionMeta } from "../../agent/store.ts";
import type { GoalRun } from "../../agent/types.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

const NOW = new Date("2026-11-03T12:00:00Z");

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("inspect not used");
    },
    getContainerLogs: async () => "",
    getStatusSummary: async () => {
      throw new Error("summary not used");
    },
  };
}

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

type SessionSeed = {
  id: string;
  lastActiveAt: string;
  labels?: Record<string, string>;
  usage: Usage;
  goal?: Pick<GoalRun, "status" | "createdAt" | "finishedAt">;
};

type ApprovalSeed = {
  id: string;
  createdAt: string;
  approvedAt?: string;
};

/**
 * A known store: three UTC days (2026-11-01 to 2026-11-03), chats and goals with fixed token
 * counts, and restart confirmations with fixed waits. Nothing here is derived from the code
 * under test.
 */
const SESSIONS: SessionSeed[] = [
  {
    id: "chat-old",
    lastActiveAt: "2026-10-01T10:00:00Z",
    usage: {
      input: 9999,
      output: 9999,
      cacheRead: 9999,
      cacheWrite: 9999,
      cost: 9,
    },
  },
  {
    id: "chat-d1",
    lastActiveAt: "2026-11-01T10:00:00Z",
    usage: {
      input: 1000,
      output: 200,
      cacheRead: 5000,
      cacheWrite: 300,
      cost: 0.05,
    },
  },
  {
    id: "chat-d3",
    lastActiveAt: "2026-11-03T09:00:00Z",
    usage: { input: 400, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
  },
  {
    id: "goal-chat",
    lastActiveAt: "2026-11-03T08:30:00Z",
    labels: { kind: "goal" },
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.002 },
    goal: {
      status: "max_iterations",
      createdAt: "2026-11-03T08:00:00Z",
      finishedAt: "2026-11-03T08:30:00Z",
    },
  },
  {
    id: "goal-done",
    lastActiveAt: "2026-11-02T01:10:00Z",
    labels: { kind: "goal", scheduleId: "sched-1" },
    usage: {
      input: 20000,
      output: 3000,
      cacheRead: 40000,
      cacheWrite: 1000,
      cost: 0.4,
    },
    goal: {
      status: "completed",
      createdAt: "2026-11-02T01:00:00Z",
      finishedAt: "2026-11-02T01:10:00Z",
    },
  },
  {
    id: "goal-failed",
    lastActiveAt: "2026-11-02T03:40:00Z",
    labels: { kind: "goal", scheduleId: "sched-1" },
    usage: { input: 5000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
    goal: {
      status: "failed",
      createdAt: "2026-11-02T03:00:00Z",
      finishedAt: "2026-11-02T03:40:00Z",
    },
  },
];

const APPROVALS: ApprovalSeed[] = [
  {
    id: "ap-1",
    createdAt: "2026-11-02T09:00:00Z",
    approvedAt: "2026-11-02T09:05:00Z",
  },
  {
    id: "ap-2",
    createdAt: "2026-11-03T09:00:00Z",
    approvedAt: "2026-11-03T09:20:00Z",
  },
  { id: "ap-pending", createdAt: "2026-11-03T10:00:00Z" },
  {
    id: "ap-old",
    createdAt: "2026-10-01T09:00:00Z",
    approvedAt: "2026-10-01T09:59:00Z",
  },
];

async function seededApp() {
  const dir = await mkdtemp(join(tmpdir(), "thebe-usage-"));
  const fake = createFakeRuntime();
  for (const seed of SESSIONS) {
    const runtimeSession = await fake.runtime.createSession({
      customTools: [],
    });
    fake.setUsage(runtimeSession.runtimeSessionId, seed.usage);
    const meta: AgentSessionMeta = {
      thebeSessionId: seed.id,
      runtimeId: fake.runtime.runtimeId,
      runtimeSessionId: runtimeSession.runtimeSessionId,
      title: seed.id,
      createdAt: seed.goal?.createdAt ?? seed.lastActiveAt,
      lastActiveAt: seed.lastActiveAt,
      labels: seed.labels,
      goalRun: seed.goal
        ? {
            thebeSessionId: seed.id,
            goal: `goal ${seed.id}`,
            maxIterations: 3,
            iteration: 1,
            subagentRunIds: [],
            ...seed.goal,
          }
        : undefined,
    };
    await mkdir(join(dir, "agent"), { recursive: true });
    await writeFile(
      join(dir, "agent", `${seed.id}.json`),
      JSON.stringify(meta)
    );
  }
  await mkdir(join(dir, "agent", "activity"), { recursive: true });
  for (const approval of APPROVALS) {
    await writeFile(
      join(dir, "agent", "activity", `${approval.id}.json`),
      JSON.stringify({
        id: approval.id,
        kind: "container.restart",
        actionId: "container.restart",
        resource: {
          kind: "container",
          id: "ctr",
          name: "emby",
          provider: "arcane",
        },
        status: approval.approvedAt ? "succeeded" : "pending",
        group: approval.approvedAt ? "recent" : "needs_approval",
        summary: "Restart emby",
        createdAt: approval.createdAt,
        updatedAt: approval.approvedAt ?? approval.createdAt,
        receiptId: approval.approvedAt ? approval.id : undefined,
        action: approval.approvedAt
          ? {
              status: "succeeded",
              finishedAt: approval.approvedAt,
              summary: "Restarted",
            }
          : undefined,
        idempotencyKey: `k-${approval.id}`,
        approval: {
          required: true,
          approved: Boolean(approval.approvedAt),
          approvedAt: approval.approvedAt,
          source: approval.approvedAt ? "on_device" : "missing",
          capability: {},
        },
      })
    );
  }
  const app = createThebeApp({
    runtime: fake.runtime,
    provider: provider(),
    agentStoreDir: join(dir, "agent"),
    now: () => NOW,
  });
  return Object.assign(app, { storeDir: join(dir, "agent") });
}

async function summary(
  app: Pick<Awaited<ReturnType<typeof seededApp>>, "handler">,
  query = "from=2026-11-01&to=2026-11-03"
) {
  const res = await app.handler.handle(
    new Request(`http://127.0.0.1:8787/v1/usage/summary?${query}`)
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

describe("GET /v1/usage/summary", () => {
  it("sums tokens per day, background apart from foreground, cache reads separate", async () => {
    const { status, body } = await summary(await seededApp());
    expect(status).toBe(200);
    expect(body.range).toEqual({
      from: "2026-11-01",
      to: "2026-11-03",
      utcOffsetMinutes: 0,
    });
    expect(body.days.map((day: any) => day.day)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
    const zero = {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      counted: 0,
      cost: 0,
      sessions: 0,
    };
    expect(body.days[0]).toEqual({
      day: "2026-11-01",
      foreground: {
        input: 1000,
        output: 200,
        cacheWrite: 300,
        cacheRead: 5000,
        counted: 1500,
        cost: 0.05,
        sessions: 1,
      },
      background: zero,
    });
    expect(body.days[1]).toEqual({
      day: "2026-11-02",
      foreground: zero,
      background: {
        input: 25000,
        output: 3500,
        cacheWrite: 1000,
        cacheRead: 40000,
        counted: 29500,
        cost: 0.5,
        sessions: 2,
      },
    });
    expect(body.days[2]).toEqual({
      day: "2026-11-03",
      foreground: {
        input: 400,
        output: 100,
        cacheWrite: 0,
        cacheRead: 0,
        counted: 500,
        cost: 0.01,
        sessions: 1,
      },
      background: {
        input: 100,
        output: 50,
        cacheWrite: 0,
        cacheRead: 0,
        counted: 150,
        cost: 0.002,
        sessions: 1,
      },
    });
    expect(body.totals.background.counted).toBe(29650);
    expect(body.totals.foreground.counted).toBe(2000);
    expect(body.totals.foreground.cacheRead).toBe(5000);
  });

  it("reports goal outcomes, completion times and tokens per goal", async () => {
    const { body } = await summary(await seededApp());
    expect(body.goals.outcomes).toEqual({
      completed: 1,
      max_iterations: 1,
      failed: 1,
      cancelled: 0,
      running: 0,
      paused: 0,
    });
    // 10 min, 30 min and 40 min; nearest-rank percentiles.
    expect(body.goals.completion).toEqual({
      count: 3,
      p50Ms: 1_800_000,
      p95Ms: 2_400_000,
      maxMs: 2_400_000,
    });
    expect(body.goals.items.map((goal: any) => goal.id)).toEqual([
      "goal-chat",
      "goal-failed",
      "goal-done",
    ]);
    const done = body.goals.items.find((goal: any) => goal.id === "goal-done");
    expect(done).toMatchObject({
      status: "completed",
      background: true,
      durationMs: 600_000,
      tokens: {
        input: 20000,
        output: 3000,
        cacheWrite: 1000,
        cacheRead: 40000,
        counted: 24000,
        cost: 0.4,
      },
    });
  });

  it("reports how long confirmations waited and how many are still waiting", async () => {
    const { body } = await summary(await seededApp());
    expect(body.confirmations).toEqual({
      answered: 2,
      pending: 1,
      wait: { count: 2, p50Ms: 300_000, p95Ms: 1_200_000, maxMs: 1_200_000 },
    });
  });

  it("narrows to the requested days and leaves everything else out", async () => {
    const { body } = await summary(
      await seededApp(),
      "from=2026-11-02&to=2026-11-02"
    );
    expect(body.days).toHaveLength(1);
    expect(body.totals.background.counted).toBe(29500);
    expect(body.totals.foreground.counted).toBe(0);
    expect(body.goals.outcomes.completed).toBe(1);
    expect(body.goals.outcomes.max_iterations).toBe(0);
    expect(body.confirmations.answered).toBe(1);
  });

  it("answers the last N days ending today and an empty store with zeros", async () => {
    const { body } = await summary(await seededApp(), "days=2");
    expect(body.range.from).toBe("2026-11-02");
    expect(body.range.to).toBe("2026-11-03");
    const empty = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      now: () => NOW,
    });
    const res = await summary(empty, "days=1");
    expect(res.body.totals.foreground.counted).toBe(0);
    expect(res.body.goals.completion).toEqual({ count: 0 });
    expect(res.body.confirmations).toMatchObject({ answered: 0, pending: 0 });
  });

  it("draws day boundaries at the caller's UTC offset", async () => {
    // At -02:00 goal-done (01:10Z on the 2nd) falls on the 1st; goal-failed (03:40Z) stays on the 2nd.
    const { body } = await summary(
      await seededApp(),
      "from=2026-11-01&to=2026-11-03&utcOffsetMinutes=-120"
    );
    expect(body.days[0].background.counted).toBe(24000);
    expect(body.days[1].background.counted).toBe(5500);
  });

  it.each([
    "from=2026-11-03&to=2026-11-01",
    "from=2026-11-01",
    "from=2026-13-01&to=2026-13-02",
    "from=2024-01-01&to=2026-01-01",
    "days=0",
    "days=abc",
    "utcOffsetMinutes=9999",
  ])("refuses the malformed query %s", async (query) => {
    const { status, body } = await summary(await seededApp(), query);
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it("only reads: asking twice gives the same answer and leaves the stores as they were", async () => {
    const app = await seededApp();
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          [
            ...(await readdir(app.storeDir)),
            ...(await readdir(join(app.storeDir, "activity"))).map(
              (n) => `activity/${n}`
            ),
          ]
            .sort()
            .map(async (name) => {
              try {
                return [name, await readFile(join(app.storeDir, name), "utf8")];
              } catch {
                return [name, "dir"];
              }
            })
        )
      );
    const before = await snapshot();
    const first = (await summary(app)).body;
    const second = (await summary(app)).body;
    expect(second).toEqual(first);
    expect(await snapshot()).toBe(before);
  });

  it("matches the contract file the App decodes (THEBE_UPDATE_CONTRACT=1 rewrites it)", async () => {
    const full = await summary(await seededApp());
    const empty = await summary(
      createThebeApp({
        runtime: createFakeRuntime().runtime,
        provider: provider(),
        now: () => NOW,
      }),
      "from=2026-11-02&to=2026-11-03&utcOffsetMinutes=480"
    );
    const rendered = `${JSON.stringify(
      {
        version: 1,
        note: "Responses of GET /v1/usage/summary for a seeded store and for an empty one.",
        cases: [
          {
            name: "seeded",
            query: "from=2026-11-01&to=2026-11-03",
            response: full.body,
          },
          {
            name: "empty",
            query: "from=2026-11-02&to=2026-11-03&utcOffsetMinutes=480",
            response: empty.body,
          },
        ],
      },
      null,
      2
    )}\n`;
    const file = new URL("../../../contracts/usage.json", import.meta.url);
    if (process.env.THEBE_UPDATE_CONTRACT === "1")
      await writeFile(file, rendered);
    expect(await readFile(file, "utf8")).toBe(rendered);
  });
});
