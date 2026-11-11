import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import type { ContainerInfoProvider } from "../capabilities/containers.ts";

afterEach(() => vi.useRealTimers());

const provider = {
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
} as unknown as ContainerInfoProvider;

const WORKER_DONE = [
  "Restarted emby and looked at it again: it is running.",
  "GOAL_STATUS: complete",
  "CHECKPOINT: emby restarted",
  "VERIFICATION: the restart request, then container state running",
  "REMAINING: none",
].join("\n");

const REVIEW_PASS =
  "VERDICT: pass\nEVIDENCE: the container tools show emby running after the restart\nREMAINING: none";

async function persistedGoal(
  dir: string,
  goalId: string
): Promise<{ status?: string } | undefined> {
  try {
    const text = await readFile(join(dir, `${goalId}.json`), "utf8");
    return (JSON.parse(text) as { goalRun?: { status?: string } }).goalRun;
  } catch {
    return undefined;
  }
}

describe("Ticket Goal recovery across Core recreation", () => {
  it("resumes a running Ticket Goal after a new Core process loads the same store", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "thebe-recovery-app-"));
    // The runtime outlives a Core process and keeps its sessions, like the Pi service does; only the
    // Agent side is recreated from the store.
    const fake = createFakeRuntime();
    const app1 = createThebeApp({
      runtime: fake.runtime,
      provider,
      agentStoreDir: dir,
    });

    let ticketId = "";
    let goalId = "";
    try {
      fake.queueTurns([{ kind: "hang" }]);
      const { ticket } = await app1.agent.delegateTicket({
        task: "Restart the stopped emby container",
        idempotencyKey: "restart-after-restart",
      });
      ticketId = ticket.id;
      goalId = ticket.links.legacyGoalId!;
      await vi.waitFor(async () => {
        expect(app1.agent.getGoal(goalId)?.status).toBe("running");
        expect(await app1.agent.listSubagents(goalId)).toHaveLength(1);
        expect(await persistedGoal(dir, goalId)).toMatchObject({
          status: "running",
        });
      });
    } finally {
      // The first process is now dead from the test's point of view: its worker turn never returned.
      await app1.agent.quiesce();
      await fake.runtime.unquiesce();
    }

    fake.queueTurns([
      { kind: "text", text: WORKER_DONE },
      { kind: "text", text: REVIEW_PASS },
    ]);
    const app2 = createThebeApp({
      runtime: fake.runtime,
      provider,
      agentStoreDir: dir,
    });

    try {
      // Reads wait for startup recovery, so this is the first post-recovery view.
      const tickets = await app2.agent.listTickets();
      expect(tickets.map((row) => row.id)).toEqual([ticketId]);
      await vi.waitFor(() => {
        expect(app2.agent.getGoal(goalId)).toMatchObject({
          status: "completed",
          executor: "ticket",
        });
      });
      expect(await app2.agent.listTickets()).toHaveLength(1);
      // The interrupted worker is kept for the record; the recovered Goal ran a fresh isolated
      // worker and reviewer on top of the same Ticket.
      const runs = await app2.agent.listSubagents(goalId);
      expect(
        runs
          .filter((run) => run.profileName === "ticket-worker")
          .map((run) => run.status)
          .sort()
      ).toEqual(["completed", "interrupted"]);
      expect(runs.map((run) => run.profileName)).toContain("ticket-reviewer");
    } finally {
      await app2.agent.quiesce();
    }
  });
});
