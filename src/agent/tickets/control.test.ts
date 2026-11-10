import { describe, expect, it, vi } from "vitest";
import type { GoalRun } from "../types.ts";
import { createTicketControlApi } from "./control.ts";
import { createTicketStore } from "./store.ts";

function goal(
  id: string,
  status: GoalRun["status"],
  updatedAt: string,
  attention?: GoalRun["attention"]
): GoalRun {
  return {
    thebeSessionId: id,
    goal: `Task ${id}`,
    maxIterations: 8,
    iteration: 1,
    status,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt,
    subagentRunIds: [],
    ...(attention ? { attention } : {}),
  };
}

describe("Ticket listing", () => {
  it("sorts by latest activity and filters stages before applying the limit", async () => {
    const store = createTicketStore({});
    const oldAttention = await store.recordDirect({
      thread: "chat",
      triggerId: "old-attention",
      kind: "goal-start",
      at: "2026-11-01T00:00:00.000Z",
      title: "Old but waiting",
      requester: "chat",
      goalId: "goal-attention",
    });
    const recentDone = await store.recordDirect({
      thread: "chat",
      triggerId: "recent-done",
      kind: "goal-start",
      at: "2026-11-09T00:00:00.000Z",
      title: "Recently created and done",
      requester: "chat",
      goalId: "goal-done",
    });
    const goals = [
      goal("goal-attention", "paused", "2026-11-10T00:00:00.000Z", {
        id: "attention-1",
        kind: "answer",
        question: "Which library?",
        askedAt: "2026-11-10T00:00:00.000Z",
      }),
      goal("goal-done", "completed", "2026-11-09T00:00:00.000Z"),
    ];
    const api = createTicketControlApi({
      store,
      goals: {
        startGoal: async () => {
          throw new Error("unused");
        },
        getGoal: (id) => goals.find((item) => item.thebeSessionId === id),
        listGoals: async () => goals,
        answerGoal: async () => {
          throw new Error("unused");
        },
        addGoalGuidance: async () => {
          throw new Error("unused");
        },
        pauseGoal: async () => {
          throw new Error("unused");
        },
        resumeGoal: async () => {
          throw new Error("unused");
        },
        stopGoal: async () => {
          throw new Error("unused");
        },
      },
      sessions: {
        createSession: async () => {
          throw new Error("unused");
        },
        listPendingPermissions: () => [],
        resolvePendingPermission: async () => {
          throw new Error("unused");
        },
      },
      now: () => new Date("2026-11-10T01:00:00.000Z"),
    });

    await expect(api.list({ limit: 1 })).resolves.toMatchObject([
      {
        ticket: { id: oldAttention.id, title: "Old but waiting" },
        stage: "attention",
      },
    ]);
    await expect(api.list({ stage: "attention" })).resolves.toMatchObject([
      { ticket: { id: oldAttention.id } },
    ]);
    await expect(api.list({ stage: "completed" })).resolves.toMatchObject([
      { ticket: { id: recentDone.id }, stage: "completed" },
    ]);
    await expect(api.list({ stage: "nonsense" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_body",
    });
  });
});

describe("Ticket guidance", () => {
  it("adds a trimmed note to live work and refuses finished or waiting Tickets", async () => {
    const store = createTicketStore({});
    const ticket = await store.recordDirect({
      thread: "chat",
      triggerId: "guidance",
      kind: "goal-start",
      at: "2026-11-10T00:00:00.000Z",
      title: "Move the library",
      requester: "chat",
      goalId: "goal-guidance",
    });
    let current = goal("goal-guidance", "running", "2026-11-10T00:00:00.000Z");
    const addGoalGuidance = vi.fn(async () => current);
    const api = createTicketControlApi({
      store,
      goals: {
        startGoal: async () => {
          throw new Error("unused");
        },
        getGoal: () => current,
        listGoals: async () => [current],
        answerGoal: async () => {
          throw new Error("unused");
        },
        addGoalGuidance,
        pauseGoal: async () => {
          throw new Error("unused");
        },
        resumeGoal: async () => {
          throw new Error("unused");
        },
        stopGoal: async () => {
          throw new Error("unused");
        },
      },
      sessions: {
        createSession: async () => {
          throw new Error("unused");
        },
        listPendingPermissions: () => [],
        resolvePendingPermission: async () => {
          throw new Error("unused");
        },
      },
      now: () => new Date("2026-11-10T01:00:00.000Z"),
    });

    await expect(
      api.note({ ticketId: ticket.id, note: "  Put it in Movies.  " })
    ).resolves.toMatchObject({
      ticket: { id: ticket.id },
      stage: "running",
    });
    expect(addGoalGuidance).toHaveBeenCalledWith(
      "goal-guidance",
      "Put it in Movies."
    );

    await expect(
      api.note({ ticketId: ticket.id, note: " " })
    ).rejects.toMatchObject({ status: 400, code: "invalid_body" });

    current = goal("goal-guidance", "paused", "2026-11-10T00:01:00.000Z", {
      id: "attention-1",
      kind: "answer",
      question: "Which library?",
      askedAt: "2026-11-10T00:01:00.000Z",
    });
    await expect(
      api.note({ ticketId: ticket.id, note: "Use Movies." })
    ).rejects.toMatchObject({ status: 409, code: "attention_open" });

    current = goal("goal-guidance", "completed", "2026-11-10T00:02:00.000Z");
    await expect(
      api.note({ ticketId: ticket.id, note: "Use Movies." })
    ).rejects.toMatchObject({ status: 409, code: "invalid_transition" });
    expect(addGoalGuidance).toHaveBeenCalledTimes(1);
  });
});
