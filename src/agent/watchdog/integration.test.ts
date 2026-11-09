import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../capabilities/containers.ts";
import { createThebeAgent } from "../create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "",
    getStatusSummary: async () => ({
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

async function flushIo(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Goal Watchdog integration", () => {
  it("retries a stalled worker once, then pauses in person with audit evidence", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = Date.parse("2026-11-09T00:00:00.000Z");
    const dir = await mkdtemp(join(tmpdir(), "thebe-watchdog-"));
    const auditPath = join(dir, "audit.jsonl");
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }, { kind: "hang" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: provider(),
      agentStoreDir: dir,
      auditPath,
      now: () => new Date(now),
      watchdog: {
        intervalMs: 50,
        workerFirstMs: 100,
        workerSecondMs: 100,
        goalFirstMs: 10_000,
        goalSecondMs: 20_000,
      },
    });

    try {
      const session = await agent.createSession({ title: "watchdog" });
      await agent.startGoal({
        thebeSessionId: session.thebeSessionId,
        goal: "Keep working",
        maxIterations: 3,
      });
      await vi.waitFor(
        () => {
          expect(
            agent.getGoal(session.thebeSessionId)?.activeSubagent?.status
          ).toBe("running");
        },
        { timeout: 3000 }
      );

      now += 100;
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(50);
      expect(agent.getGoal(session.thebeSessionId)).toMatchObject({
        watchdog: { state: "retrying" },
      });
      await vi.waitFor(
        () => {
          expect(
            agent.getGoal(session.thebeSessionId)?.subagentRunIds
          ).toHaveLength(2);
        },
        { timeout: 3000 }
      );

      now += 100;
      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(
        () => {
          expect(agent.getGoal(session.thebeSessionId)?.status).toBe("paused");
        },
        { timeout: 3000 }
      );
      const finished = agent.getGoal(session.thebeSessionId)!;
      expect(finished).toMatchObject({
        status: "paused",
        watchdog: {
          state: "waiting_for_person",
          reason: "worker_inactivity",
          action: "pause",
        },
      });
      expect(finished.summary).toContain("Paused by Watchdog");

      const audit = await agent.listAudit({ limit: 20 });
      expect(audit.entries.map((entry) => entry.method)).toEqual(
        expect.arrayContaining(["watchdog.retry_worker", "watchdog.pause"])
      );
      expect(
        audit.entries.filter(
          (entry) => entry.method === "watchdog.retry_worker"
        )
      ).toHaveLength(1);
    } finally {
      await agent.quiesce();
    }
  });

  it("runs one read-only status check for a quiet Goal, then escalates it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = Date.parse("2026-11-09T01:00:00.000Z");
    const dir = await mkdtemp(join(tmpdir(), "thebe-watchdog-status-"));
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "hang" },
      { kind: "text", text: "The worker has produced no new evidence." },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: provider(),
      agentStoreDir: dir,
      auditPath: join(dir, "audit.jsonl"),
      now: () => new Date(now),
      watchdog: {
        intervalMs: 50,
        goalFirstMs: 100,
        goalSecondMs: 200,
        workerFirstMs: 10_000,
        workerSecondMs: 10_000,
      },
    });

    try {
      const session = await agent.createSession({ title: "quiet goal" });
      await agent.startGoal({
        thebeSessionId: session.thebeSessionId,
        goal: "Finish the quiet task",
        maxIterations: 2,
      });
      await vi.waitFor(
        () => {
          expect(
            agent.getGoal(session.thebeSessionId)?.activeSubagent?.status
          ).toBe("running");
        },
        { timeout: 3000 }
      );

      now += 100;
      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(
        () => {
          expect(agent.getGoal(session.thebeSessionId)?.watchdog?.state).toBe(
            "checking"
          );
        },
        { timeout: 3000 }
      );
      await flushIo();
      expect(
        (await agent.listSubagents(session.thebeSessionId)).some(
          (run) => run.profileName === "goal-observer"
        )
      ).toBe(true);

      now += 100;
      await vi.advanceTimersByTimeAsync(50);
      await flushIo();
      await vi.waitFor(
        () => {
          expect(agent.getGoal(session.thebeSessionId)?.status).toBe("paused");
        },
        { timeout: 3000 }
      );
      const finished = agent.getGoal(session.thebeSessionId)!;
      expect(finished).toMatchObject({
        status: "paused",
        watchdog: {
          state: "waiting_for_person",
          reason: "goal_no_progress",
          action: "pause",
        },
      });
      const audit = await agent.listAudit({ limit: 20 });
      expect(
        audit.entries.filter(
          (entry) => entry.method === "watchdog.status_check"
        )
      ).toHaveLength(1);
      expect(
        audit.entries.filter((entry) => entry.method === "watchdog.pause")
      ).toHaveLength(1);
    } finally {
      await agent.quiesce();
    }
  });
});
