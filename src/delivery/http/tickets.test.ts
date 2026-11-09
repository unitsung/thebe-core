import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

const provider: ContainerInfoProvider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => "ok",
  getStatusSummary: async () => ({
    totalContainers: 0,
    runningContainers: 0,
    pausedContainers: 0,
    exitedContainers: 0,
    lastUpdated: 1,
  }),
};

const pass = {
  kind: "text" as const,
  text: "VERDICT: pass\nEVIDENCE: checked it\nREMAINING: none",
};

type FakeTurnBatch = Parameters<
  ReturnType<typeof createFakeRuntime>["queueTurns"]
>[0];

const defaultTurns: FakeTurnBatch = [
  { kind: "text", text: "GOAL_STATUS: complete" },
  pass,
];

function open(
  agentStoreDir?: string,
  turns: FakeTurnBatch = defaultTurns,
  now?: () => Date
) {
  const fake = createFakeRuntime();
  fake.queueTurns(turns);
  const app = createThebeApp({
    runtime: fake.runtime,
    provider,
    agentStoreDir,
    now,
  });
  const call = async (path: string, init?: RequestInit) => {
    const res = await app.handler.handle(
      new Request(`http://127.0.0.1:8787${path}`, {
        ...init,
        headers: { "content-type": "application/json" },
      })
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  };
  return { app, call };
}

const newGoal = {
  method: "POST",
  body: JSON.stringify({ goal: "Move the library", maxIterations: 2 }),
};

describe("tickets", () => {
  it("starts empty, and a Core that has them says so on /v1/health", async () => {
    const { call } = open();
    expect((await call("/v1/tickets")).body).toEqual({ tickets: [] });
    expect((await call("/v1/health")).body.capabilities).toContain("tickets");
  });

  it("makes an explicit, direct Ticket for a task the person asks for, and links it from the task", async () => {
    const { app, call } = open();
    const created = await call("/v1/goals", newGoal);
    expect(created.status).toBe(201);
    await app.agent.waitGoal(created.body.id);

    const ticketId = created.body.ticketId as string;
    expect(ticketId).toMatch(/^[a-f0-9]{32}$/);
    expect((await call(`/v1/goals/${created.body.id}`)).body.ticketId).toBe(
      ticketId
    );
    const listed = (await call("/v1/goals")).body.goals as Array<
      Record<string, any>
    >;
    expect(listed.find((g) => g.id === created.body.id)?.ticketId).toBe(
      ticketId
    );

    const tickets = (await call("/v1/tickets")).body.tickets as Array<
      Record<string, any>
    >;
    expect(tickets).toHaveLength(1);
    const ticket = (await call(`/v1/tickets/${ticketId}`)).body;
    expect(ticket).toMatchObject({
      id: ticketId,
      title: "Move the library",
      mandate: { strength: "explicit", decidedBy: "direct", requester: "chat" },
      links: { legacyGoalId: created.body.id, sessionIds: [created.body.id] },
    });
    // The Ticket does not copy what the Goal owns.
    expect(ticket).not.toHaveProperty("status");
    expect(ticket).not.toHaveProperty("stage");
  });

  it("rejects unsupported Ticket methods and unknown ids", async () => {
    const { call } = open();
    expect(
      (
        await call("/v1/tickets/" + "0".repeat(32), {
          method: "POST",
          body: "{}",
        })
      ).status
    ).toBe(405);
    expect((await call("/v1/tickets/abc", { method: "DELETE" })).status).toBe(
      405
    );
    expect((await call("/v1/tickets/" + "0".repeat(32))).status).toBe(404);
    expect((await call("/v1/tickets/..%2F..%2Fetc")).status).toBe(404);
    expect((await call("/v1/tickets/" + "0".repeat(32) + "/x")).status).toBe(
      404
    );
  });

  it("keeps its Tickets across a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tickets-http-"));
    const first = open(dir);
    const created = await first.call("/v1/goals", newGoal);
    await first.app.agent.waitGoal(created.body.id);

    const second = open(dir);
    const tickets = (await second.call("/v1/tickets")).body.tickets as Array<
      Record<string, any>
    >;
    expect(tickets.map((t) => t.id)).toEqual([created.body.ticketId]);
  });

  it("backfills existing Goals once without changing their Goal identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tickets-backfill-"));
    const first = open(
      dir,
      defaultTurns,
      () => new Date("2026-11-09T00:00:00.000Z")
    );
    const session = await first.app.agent.createSession({
      title: "Legacy backup task",
    });
    const run = await first.app.agent.startGoal({
      thebeSessionId: session.thebeSessionId,
      goal: "Verify the legacy backup",
    });
    await first.app.agent.waitGoal(run.thebeSessionId);
    expect(await first.app.agent.getTicketForGoal(run.thebeSessionId)).toBe(
      undefined
    );

    const second = open(dir, [], () => new Date("2026-11-10T00:00:00.000Z"));
    const firstRead = (await second.call("/v1/tickets")).body.tickets as Array<
      Record<string, any>
    >;
    const secondRead = (await second.call("/v1/tickets")).body.tickets as Array<
      Record<string, any>
    >;

    expect(firstRead).toHaveLength(1);
    expect(secondRead).toEqual(firstRead);
    expect(firstRead[0]).toMatchObject({
      title: "Verify the legacy backup",
      mandate: {
        strength: "explicit",
        decidedBy: "direct",
        requester: "migration",
      },
      links: {
        legacyGoalId: run.thebeSessionId,
        sessionIds: [run.thebeSessionId],
      },
      createdAt: run.createdAt,
    });
    const goal = (await second.call(`/v1/goals/${run.thebeSessionId}`)).body;
    expect(goal).toMatchObject({
      id: run.thebeSessionId,
      ticketId: firstRead[0]?.id,
    });
  });

  it("delegates idempotently and replies to the Ticket's attention", async () => {
    const { app, call } = open(undefined, [
      {
        kind: "tools",
        calls: [
          {
            name: "goal_report",
            args: {
              state: "ask",
              question: "Which library should I move?",
              options: ["Movies", "Shows"],
            },
          },
        ],
      },
    ]);
    const request = {
      task: "Move the selected library",
      idempotencyKey: "http-delegate-library",
      criteria: ["the selected library is in its new location"],
    };
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      reused: false,
      ticket: {
        title: "Move the selected library",
        mandate: {
          strength: "explicit",
          decidedBy: "direct",
          requester: "http",
        },
      },
      stage: "running",
      goal: { status: "running" },
    });
    const ticketId = created.body.ticket.id as string;
    const goalId = created.body.goal.id as string;

    const retried = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      reused: true,
      ticket: { id: ticketId },
      goal: { id: goalId },
    });

    await vi.waitFor(() => {
      expect(app.agent.getGoal(goalId)?.attention?.kind).toBe("answer");
    });
    const attention = app.agent.getGoal(goalId)?.attention;
    expect(attention).toBeDefined();

    const replied = await call(`/v1/tickets/${ticketId}/reply`, {
      method: "POST",
      body: JSON.stringify({
        attentionId: attention?.id,
        answer: "Movies",
      }),
    });
    expect(replied.status).toBe(200);
    expect(replied.body).toMatchObject({
      ticket: { id: ticketId },
      stage: expect.any(String),
    });
    expect(
      (
        await call(`/v1/goals/${goalId}/stop`, {
          method: "POST",
          body: "{}",
        })
      ).status
    ).toBe(200);
  });

  it("validates Ticket commands and refuses writes while quiesced", async () => {
    const { app, call } = open();
    const invalid = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({ task: "Inspect the library" }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("invalid_body");

    await app.agent.quiesce();
    const blocked = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Inspect the library",
        idempotencyKey: "quiesced-http",
      }),
    });
    expect(blocked.status).toBe(503);
    const blockedReply = await call(`/v1/tickets/${"0".repeat(32)}/reply`, {
      method: "POST",
      body: JSON.stringify({ attentionId: "attention" }),
    });
    expect(blockedReply.status).toBe(503);
  });

  it("resolves one pending worker permission by Ticket id", async () => {
    const { app, call } = open(undefined, [
      {
        kind: "tools",
        calls: [
          {
            name: "write",
            args: { path: "notes.txt", content: "updated" },
          },
          {
            name: "goal_report",
            args: {
              state: "dropped",
              reason: "nothing else needs changing",
            },
          },
        ],
      },
    ]);
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Update the temporary workspace",
        idempotencyKey: "http-permission",
      }),
    });
    expect(created.status).toBe(201);
    await vi.waitFor(() => {
      expect(app.agent.listPendingPermissions()).toHaveLength(1);
    });
    const pending = app.agent.listPendingPermissions()[0]!;

    const replied = await call(`/v1/tickets/${created.body.ticket.id}/reply`, {
      method: "POST",
      body: JSON.stringify({
        permissionId: pending.id,
        permissionDecision: "allow",
      }),
    });
    expect(replied.status).toBe(200);
    expect(replied.body.pendingPermissions).toEqual([]);
    await expect(
      app.agent.waitGoal(created.body.goal.id)
    ).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("finds an HTTP-delegated Ticket after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-http-delegate-"));
    const first = open(dir);
    const created = await first.call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Inspect the library",
        idempotencyKey: "http-restart",
        observe: true,
      }),
    });
    expect(created.status).toBe(201);
    await first.app.agent.waitGoal(created.body.goal.id);

    const second = open(dir, []);
    const retried = await second.call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Inspect the library",
        idempotencyKey: "http-restart",
        observe: true,
      }),
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      reused: true,
      ticket: { id: created.body.ticket.id },
      goal: { id: created.body.goal.id },
    });
  });
});
