import { describe, expect, it, vi } from "vitest";
import type { GoalRun } from "../types.ts";
import type { Ticket } from "./types.ts";
import type { TicketStore } from "./store.ts";
import { recoverInterruptedTicketGoals } from "./recovery.ts";

function ticket(id: string, goalId?: string): Ticket {
  return {
    id: id.padEnd(32, "0"),
    title: "Work",
    mandate: {
      strength: "inferred",
      decidedBy: "eval",
      evalId: "e".repeat(32),
      requester: "github",
      matchedRuleIds: ["rule-1"],
      scope: ["docker:write"],
    },
    subscriptions: ["resource:container:emby"],
    inputs: [],
    origins: [],
    channels: [],
    links: {
      ...(goalId ? { legacyGoalId: goalId } : {}),
      sessionIds: goalId ? [goalId] : [],
    },
    createdAt: "2026-11-11T09:00:00.000Z",
  };
}

function goal(
  id: string,
  status: GoalRun["status"],
  executor?: "ticket"
): GoalRun {
  return {
    thebeSessionId: id,
    goal: "Restart it",
    iteration: 1,
    maxIterations: 3,
    status,
    createdAt: "2026-11-11T09:00:00.000Z",
    updatedAt: "2026-11-11T09:01:00.000Z",
    subagentRunIds: [],
    ...(executor ? { executor } : {}),
  };
}

function store(tickets: Ticket[]): TicketStore {
  return {
    list: async () => tickets,
  } as unknown as TicketStore;
}

describe("Ticket assignment recovery", () => {
  it("resumes only Ticket Goals that were running when the process ended", async () => {
    const tickets = [
      ticket("a".repeat(32), "goal-running"),
      ticket("b".repeat(32), "goal-paused"),
      ticket("c".repeat(32), "goal-chat"),
      ticket("d".repeat(32), "goal-foreign"),
      ticket("e".repeat(32), "goal-denied"),
    ];
    const metas = new Map<string, { goalRun: GoalRun; goalEvents: [] }>([
      [
        "goal-running",
        { goalRun: goal("goal-running", "running", "ticket"), goalEvents: [] },
      ],
      [
        "goal-paused",
        { goalRun: goal("goal-paused", "paused", "ticket"), goalEvents: [] },
      ],
      ["goal-chat", { goalRun: goal("goal-chat", "running"), goalEvents: [] }],
      [
        "goal-denied",
        { goalRun: goal("goal-denied", "pausing", "ticket"), goalEvents: [] },
      ],
    ]);
    const restored: string[] = [];
    const resumed: string[] = [];

    const recovered = await recoverInterruptedTicketGoals({
      tickets: store(tickets),
      lookup: async (goalId) => {
        if (goalId === "goal-foreign") throw new Error("store unavailable");
        return metas.get(goalId) ?? {};
      },
      restore: (run) => restored.push(run.thebeSessionId),
      revalidate: async (goalId) =>
        goalId === "goal-denied"
          ? { allowed: false, reason: "policy changed" }
          : { allowed: true },
      resume: async (goalId) => resumed.push(goalId),
      onError: () => {},
    });

    expect(restored).toEqual(["goal-running", "goal-denied"]);
    expect(resumed).toEqual(["goal-running"]);
    expect(recovered).toEqual([
      { ticketId: "a".repeat(32), goalId: "goal-running" },
    ]);
  });

  it("leaves a Ticket alone when the policy no longer authorizes its Mandate", async () => {
    const resume = vi.fn();
    const recovered = await recoverInterruptedTicketGoals({
      tickets: store([ticket("f".repeat(32), "goal-f")]),
      lookup: async () => ({
        goalRun: goal("goal-f", "running", "ticket"),
      }),
      restore: () => {},
      revalidate: async () => ({ allowed: false, reason: "rule removed" }),
      resume,
    });
    expect(recovered).toEqual([]);
    expect(resume).not.toHaveBeenCalled();
  });

  it("ignores a Ticket with no Goal and a Goal that already ended", async () => {
    const resume = vi.fn();
    await recoverInterruptedTicketGoals({
      tickets: store([
        ticket("1".repeat(32)),
        ticket("2".repeat(32), "goal-done"),
      ]),
      lookup: async () => ({
        goalRun: goal("goal-done", "completed", "ticket"),
      }),
      restore: () => {},
      revalidate: async () => ({ allowed: true }),
      resume,
    });
    expect(resume).not.toHaveBeenCalled();
  });
});
