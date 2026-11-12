import { describe, expect, it } from "vitest";
import {
  createGoalWatchdog,
  type GoalWatchdogTarget,
  type TicketWatchdogContext,
  type WatchdogDecision,
} from "./service.ts";
import type { SubagentRun } from "../types.ts";

const START = "2026-11-09T00:00:00.000Z";

function worker(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    runId: "worker-1",
    parentSessionId: "goal-1",
    profileName: "goal-worker",
    task: "work",
    status: "running",
    turns: 0,
    maxTurns: 8,
    createdAt: START,
    startedAt: START,
    activity: [
      {
        id: 1,
        at: START,
        kind: "status",
        title: "running",
      },
    ],
    ...overrides,
  };
}

function target(
  overrides: Partial<GoalWatchdogTarget> = {}
): GoalWatchdogTarget {
  return {
    goalId: "goal-1",
    goal: "Ship the change",
    iteration: 1,
    status: "running",
    createdAt: START,
    updatedAt: START,
    progressAt: START,
    ...overrides,
  };
}

describe("Goal Watchdog planner", () => {
  it("performs one bounded status check, then pauses at the second Goal threshold", async () => {
    let now = new Date(START);
    const decisions: WatchdogDecision[] = [];
    const watchdog = createGoalWatchdog({
      listTargets: () => [target()],
      execute: async (decision) => {
        decisions.push(decision);
      },
      now: () => now,
      goalFirstMs: 30 * 60_000,
      goalSecondMs: 60 * 60_000,
    });

    now = new Date(Date.parse(START) + 30 * 60_000);
    await watchdog.pollOnce();
    await watchdog.pollOnce();
    expect(decisions.map((decision) => decision.type)).toEqual([
      "status_check",
    ]);

    now = new Date(Date.parse(START) + 60 * 60_000);
    await watchdog.pollOnce();
    expect(decisions.map((decision) => decision.type)).toEqual([
      "status_check",
      "pause",
    ]);
    expect(decisions[1]).toMatchObject({
      reason: "goal_no_progress",
      inactivityMs: 60 * 60_000,
    });
  });

  it("retries a stalled worker once and escalates if the retry does not progress", async () => {
    let now = new Date(Date.parse(START) + 10 * 60_000);
    const decisions: WatchdogDecision[] = [];
    const watchdog = createGoalWatchdog({
      listTargets: () => [target({ activeSubagent: worker() })],
      execute: async (decision) => {
        decisions.push(decision);
      },
      now: () => now,
      goalFirstMs: 30 * 60_000,
      goalSecondMs: 60 * 60_000,
      workerFirstMs: 10 * 60_000,
      workerSecondMs: 10 * 60_000,
    });

    await watchdog.pollOnce();
    await watchdog.pollOnce();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      type: "retry_worker",
      reason: "worker_inactivity",
      run: { runId: "worker-1" },
    });

    now = new Date(Date.parse(START) + 20 * 60_000);
    await watchdog.pollOnce();
    expect(decisions[1]).toMatchObject({
      type: "pause",
      reason: "worker_inactivity",
    });
  });

  it("treats a replacement worker as progress instead of retrying forever", async () => {
    let now = new Date(Date.parse(START) + 10 * 60_000);
    let current = target({ activeSubagent: worker() });
    const decisions: WatchdogDecision[] = [];
    const watchdog = createGoalWatchdog({
      listTargets: () => [current],
      execute: async (decision) => {
        decisions.push(decision);
      },
      now: () => now,
      workerFirstMs: 10 * 60_000,
      workerSecondMs: 10 * 60_000,
    });
    await watchdog.pollOnce();
    now = new Date(Date.parse(START) + 11 * 60_000);
    current = target({
      progressAt: "2026-11-09T00:10:01.000Z",
      updatedAt: "2026-11-09T00:10:01.000Z",
      activeSubagent: worker({
        runId: "worker-2",
        startedAt: "2026-11-09T00:10:01.000Z",
        createdAt: "2026-11-09T00:10:01.000Z",
        activity: [
          {
            id: 1,
            at: "2026-11-09T00:10:01.000Z",
            kind: "status",
            title: "running",
          },
        ],
      }),
    });
    await watchdog.pollOnce();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.type).toBe("retry_worker");
  });

  it("does not notify or intervene on a task already waiting for the person", async () => {
    const decisions: WatchdogDecision[] = [];
    const watchdog = createGoalWatchdog({
      listTargets: () => [
        target({
          status: "paused",
          watchdog: {
            state: "waiting_for_person",
            reason: "goal_no_progress",
            action: "pause",
            since: START,
            at: START,
          },
        }),
      ],
      execute: async (decision) => {
        decisions.push(decision);
      },
      now: () => new Date("2026-11-10T00:00:00.000Z"),
    });
    await watchdog.pollOnce();
    expect(decisions).toEqual([]);
  });
});

describe("Goal Watchdog Ticket classes", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const cases: Array<{
    name: string;
    ticket: TicketWatchdogContext;
    firstMs: number;
    secondMs: number;
  }> = [
    {
      name: "container health",
      ticket: {
        origins: [{ source: "container-health", kind: "container.went_down" }],
        subscriptions: ["resource:container:emby"],
      },
      firstMs: 15 * MINUTE,
      secondMs: 30 * MINUTE,
    },
    {
      name: "download completed",
      ticket: {
        origins: [
          { source: "download-completed", kind: "download.completed" },
        ],
        subscriptions: ["resource:download:qbittorrent:" + "a".repeat(40)],
      },
      firstMs: 2 * HOUR,
      secondMs: 4 * HOUR,
    },
    {
      name: "post-download pipeline",
      ticket: {
        origins: [{ source: "pipeline", kind: "pipeline.started" }],
        subscriptions: ["resource:pipeline:job-1"],
      },
      firstMs: 30 * MINUTE,
      secondMs: 60 * MINUTE,
    },
    {
      name: "library scan",
      ticket: {
        origins: [{ source: "library-scan", kind: "library.scan" }],
        subscriptions: ["resource:library:emby"],
      },
      firstMs: 2 * HOUR,
      secondMs: 4 * HOUR,
    },
    {
      name: "other Ticket",
      ticket: {
        origins: [{ source: "github", kind: "github.issue.opened" }],
        subscriptions: ["github:unitsung/thebe-core"],
      },
      firstMs: 15 * MINUTE,
      secondMs: 30 * MINUTE,
    },
  ];

  for (const testCase of cases) {
    it(`checks first and pauses at the ${testCase.name} thresholds`, async () => {
      let now = new Date(START);
      const decisions: WatchdogDecision[] = [];
      const watchdog = createGoalWatchdog({
        listTargets: () => [
          target({
            goal: "Personal coding goal: container download pipeline scan",
            executor: "ticket",
            ticket: testCase.ticket,
          }),
        ],
        execute: async (decision) => {
          decisions.push(decision);
        },
        now: () => now,
      });

      now = new Date(Date.parse(START) + testCase.firstMs - 1);
      await watchdog.pollOnce();
      expect(decisions).toEqual([]);

      now = new Date(Date.parse(START) + testCase.firstMs);
      await watchdog.pollOnce();
      expect(decisions.map((decision) => decision.type)).toEqual([
        "status_check",
      ]);
      expect(decisions[0]).toMatchObject({
        reason: "goal_no_progress",
        inactivityMs: testCase.firstMs,
      });

      now = new Date(Date.parse(START) + testCase.secondMs);
      await watchdog.pollOnce();
      expect(decisions.map((decision) => decision.type)).toEqual([
        "status_check",
        "pause",
      ]);
      expect(decisions[1]).toMatchObject({
        reason: "goal_no_progress",
        inactivityMs: testCase.secondMs,
      });
    });
  }

  it("honours the class the Goal resolved from its stored Ticket", async () => {
    let now = new Date(START);
    const decisions: WatchdogDecision[] = [];
    const watchdog = createGoalWatchdog({
      listTargets: () => [
        target({ executor: "ticket", watchdogClass: "download" }),
      ],
      execute: async (decision) => {
        decisions.push(decision);
      },
      now: () => now,
    });

    now = new Date(Date.parse(START) + 2 * HOUR - 1);
    await watchdog.pollOnce();
    expect(decisions).toEqual([]);

    now = new Date(Date.parse(START) + 2 * HOUR);
    await watchdog.pollOnce();
    expect(decisions[0]).toMatchObject({ type: "status_check" });
  });

  it("uses the resource Thread when the Ticket has no matching origin", async () => {
    let now = new Date(START);
    const decisions: WatchdogDecision[] = [];
    const watchdog = createGoalWatchdog({
      listTargets: () => [
        target({
          executor: "ticket",
          ticket: {
            origins: [],
            subscriptions: ["resource:container:emby"],
          },
        }),
      ],
      execute: async (decision) => {
        decisions.push(decision);
      },
      now: () => now,
    });

    now = new Date(Date.parse(START) + 15 * MINUTE);
    await watchdog.pollOnce();
    expect(decisions.map((decision) => decision.type)).toEqual([
      "status_check",
    ]);
  });

  it("keeps the configured thresholds for a personal coding Goal", async () => {
    let now = new Date(START);
    const decisions: WatchdogDecision[] = [];
    const watchdog = createGoalWatchdog({
      listTargets: () => [
        target({ goal: "Fix the container download pipeline scan" }),
      ],
      execute: async (decision) => {
        decisions.push(decision);
      },
      now: () => now,
      goalFirstMs: 45 * MINUTE,
      goalSecondMs: 90 * MINUTE,
    });

    now = new Date(Date.parse(START) + 45 * MINUTE - 1);
    await watchdog.pollOnce();
    expect(decisions).toEqual([]);

    now = new Date(Date.parse(START) + 45 * MINUTE);
    await watchdog.pollOnce();
    expect(decisions[0]).toMatchObject({ type: "status_check" });

    now = new Date(Date.parse(START) + 90 * MINUTE);
    await watchdog.pollOnce();
    expect(decisions[1]).toMatchObject({ type: "pause" });
  });
});
