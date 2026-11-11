import { describe, expect, it, vi } from "vitest";
import type { Trigger } from "../sources/types.ts";
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
        retryGoal: async () => {
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

  it("finds old relationships without widening the model-facing list limit", async () => {
    const store = createTicketStore({});
    const thread = "resource:container:backup-agent";
    const related = await store.recordDirect({
      thread,
      triggerId: "old-related",
      kind: "goal-start",
      at: "2026-11-01T00:00:00.000Z",
      title: "Old backup work",
      requester: "chat",
      goalId: "goal-old-related",
    });
    for (let index = 0; index < 51; index += 1) {
      await store.recordDirect({
        thread: "chat",
        triggerId: `newer-${index}`,
        kind: "goal-start",
        at: new Date(Date.UTC(2026, 10, 2, 0, index)).toISOString(),
        title: `Newer work ${index}`,
        requester: "chat",
      });
    }
    const run = goal(
      "goal-old-related",
      "completed",
      "2026-11-01T00:05:00.000Z"
    );
    const api = createTicketControlApi({
      store,
      goals: {
        startGoal: async () => {
          throw new Error("unused");
        },
        getGoal: () => run,
        listGoals: async () => [run],
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
        retryGoal: async () => {
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

    const recent = await api.list({ limit: 50 });
    expect(recent.map((view) => view.ticket.id)).not.toContain(related.id);
    await expect(
      api.related({ subscriptions: [thread] })
    ).resolves.toMatchObject([
      { ticket: { id: related.id }, stage: "completed" },
    ]);
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
        retryGoal: async () => {
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

describe("Ticket retry", () => {
  it("retries failed work but refuses completed, active, and person-stopped Tickets", async () => {
    const store = createTicketStore({});
    const ticket = await store.recordDirect({
      thread: "chat",
      triggerId: "retry",
      kind: "goal-start",
      at: "2026-11-10T00:00:00.000Z",
      title: "Move the library",
      requester: "chat",
      goalId: "goal-retry",
    });
    let current = goal("goal-retry", "failed", "2026-11-10T00:01:00.000Z");
    const retryGoal = vi.fn(async () => {
      current = goal("goal-retry", "running", "2026-11-10T00:02:00.000Z");
      return current;
    });
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
        retryGoal,
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

    const failedView = await api.get(ticket.id);
    expect(failedView?.canRetry).toBe(true);
    expect(failedView?.receipt.canRetry).toBe(true);

    await expect(
      api.control({ ticketId: ticket.id, action: "retry" })
    ).resolves.toMatchObject({
      ticket: { id: ticket.id },
      stage: "running",
      canRetry: false,
    });
    expect(retryGoal).toHaveBeenCalledWith("goal-retry");

    current = goal("goal-retry", "max_iterations", "2026-11-10T00:02:30.000Z");
    await expect(
      api.control({ ticketId: ticket.id, action: "retry" })
    ).resolves.toMatchObject({
      ticket: { id: ticket.id },
      stage: "running",
    });

    current = goal("goal-retry", "completed", "2026-11-10T00:03:00.000Z");
    await expect(
      api.control({ ticketId: ticket.id, action: "retry" })
    ).rejects.toMatchObject({
      status: 409,
      code: "invalid_transition",
    });

    current = goal("goal-retry", "cancelled", "2026-11-10T00:04:00.000Z");
    await expect(
      api.control({ ticketId: ticket.id, action: "retry" })
    ).rejects.toMatchObject({
      status: 409,
      code: "ticket_stopped",
    });

    current = goal("goal-retry", "running", "2026-11-10T00:05:00.000Z");
    await expect(
      api.control({ ticketId: ticket.id, action: "retry" })
    ).rejects.toMatchObject({
      status: 409,
      code: "invalid_transition",
    });
    expect(retryGoal).toHaveBeenCalledTimes(2);
  });

  it("binds an explicitly admitted Source request to one durable direct Ticket", async () => {
    const at = "2026-11-06T10:00:00.000Z";
    const channel = {
      source: "external-chat",
      thread: "conversation:42",
      address: { conversationId: "42" },
    };
    const trigger: Trigger = {
      id: "d".repeat(32),
      source: "external-chat",
      kind: "message.created",
      at,
      threads: [channel.thread],
      payload: { text: "Please inspect this request." },
      actor: { source: "external-chat", id: "person-7" },
      human: true,
      admission: "explicit",
      addressed: "direct",
      channel,
    };
    const inferred: Trigger = {
      ...trigger,
      id: "e".repeat(32),
      admission: "inferred",
    };
    const tickets = createTicketStore({});
    let current: GoalRun | undefined;
    let startedGoal = "";
    let createdSessions = 0;
    const api = createTicketControlApi({
      store: tickets,
      triggers: {
        get: async (id) =>
          id === trigger.id
            ? trigger
            : id === inferred.id
              ? inferred
              : undefined,
      },
      goals: {
        startGoal: async (input) => {
          startedGoal = input.goal;
          current = {
            ...goal("goal-source", "running", at),
            goal: input.goal,
          };
          return current;
        },
        getGoal: (id) => (current?.thebeSessionId === id ? current : undefined),
        listGoals: async () => (current ? [current] : []),
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
        retryGoal: async () => {
          throw new Error("unused");
        },
      },
      sessions: {
        createSession: async () => {
          createdSessions += 1;
          return { thebeSessionId: "goal-source" };
        },
        listPendingPermissions: () => [],
        resolvePendingPermission: async () => {
          throw new Error("unused");
        },
      },
      now: () => new Date("2026-11-10T01:00:00.000Z"),
    });

    const first = await api.delegateHttp({
      task: "Inspect the admitted request.",
      idempotencyKey: "first-attempt",
      triggerId: trigger.id,
    });
    const duplicate = await api.delegateHttp({
      task: "Inspect the admitted request.",
      idempotencyKey: "different-retry-key",
      triggerId: trigger.id,
    });

    expect(first).toMatchObject({ reused: false });
    expect(duplicate).toMatchObject({ reused: true });
    expect(duplicate.ticket.id).toBe(first.ticket.id);
    expect(first.ticket).toMatchObject({
      mandate: { strength: "explicit", decidedBy: "direct" },
      subscriptions: [channel.thread],
      origins: [
        {
          triggerId: trigger.id,
          source: trigger.source,
          actor: trigger.actor,
          human: true,
          admission: "explicit",
          addressed: "direct",
          channel,
        },
      ],
      channels: [channel],
    });
    expect(startedGoal).toContain("Please inspect this request.");
    expect(startedGoal).toContain("untrusted");
    expect(createdSessions).toBe(1);

    await expect(
      api.delegateHttp({
        task: "Do not use an inferred event as an explicit request.",
        idempotencyKey: "inferred",
        triggerId: inferred.id,
      })
    ).rejects.toMatchObject({
      status: 409,
      code: "trigger_not_explicit",
    });
    expect(createdSessions).toBe(1);
  });
});

describe("Ticket startup recovery gate", () => {
  it("holds HTTP reads and MCP tool calls until interrupted assignments are restored", async () => {
    const store = createTicketStore({});
    const ticket = await store.recordDirect({
      thread: "chat",
      triggerId: "recovered",
      kind: "goal-start",
      at: "2026-11-10T00:00:00.000Z",
      title: "Interrupted work",
      requester: "chat",
      goalId: "goal-recovered",
    });
    const run = goal("goal-recovered", "running", "2026-11-10T00:00:05.000Z");
    let restored = false;
    let goalReads = 0;
    let releaseRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const unused = async () => {
      throw new Error("unused");
    };
    const api = createTicketControlApi({
      store,
      ready: () => recovery,
      goals: {
        startGoal: unused,
        getGoal: (id) => {
          goalReads += 1;
          return restored && id === run.thebeSessionId ? run : undefined;
        },
        listGoals: async () => {
          goalReads += 1;
          return restored ? [run] : [];
        },
        answerGoal: unused,
        addGoalGuidance: unused,
        pauseGoal: unused,
        resumeGoal: unused,
        stopGoal: unused,
        retryGoal: unused,
      },
      sessions: {
        createSession: unused,
        listPendingPermissions: () => [],
        resolvePendingPermission: unused,
      },
      now: () => new Date("2026-11-10T01:00:00.000Z"),
    });

    const read = api.get(ticket.id);
    const listed = api.list();
    const invoked = api.invoke(
      "ticket_list",
      {},
      { writes: false, irreversible: false }
    );
    // Let every caller run to its first real await. None may observe the Goal side before the
    // recovery promise settles, or it would report this assignment as unassigned.
    await Promise.resolve();
    await Promise.resolve();
    expect(goalReads).toBe(0);

    restored = true;
    releaseRecovery();

    await expect(read).resolves.toMatchObject({
      ticket: { id: ticket.id },
      stage: "running",
      assignment: { state: "running", goalId: "goal-recovered" },
    });
    await expect(listed).resolves.toMatchObject([
      { ticket: { id: ticket.id }, stage: "running" },
    ]);
    await expect(invoked).resolves.toMatchObject({
      tickets: [{ ticket: { id: ticket.id }, stage: "running" }],
    });
  });
});
