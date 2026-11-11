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
  return { app, call, fake };
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

  it("documents Ticket reads, reply and Goal controls", async () => {
    const { call } = open();
    const spec = await call("/openapi.json");
    expect(spec.body.paths).toMatchObject({
      "/v1/tickets": {
        get: expect.any(Object),
        post: expect.any(Object),
      },
      "/v1/tickets/{id}": { get: expect.any(Object) },
      "/v1/tickets/{id}/reply": { post: expect.any(Object) },
      "/v1/tickets/{id}/note": { post: expect.any(Object) },
      "/v1/tickets/{id}/pause": { post: expect.any(Object) },
      "/v1/tickets/{id}/resume": { post: expect.any(Object) },
      "/v1/tickets/{id}/stop": { post: expect.any(Object) },
      "/v1/tickets/{id}/retry": { post: expect.any(Object) },
    });
    expect(spec.body.components.schemas.Ticket.required).toEqual(
      expect.arrayContaining(["inputs", "origins", "channels"])
    );
    expect(spec.body.components.schemas.TicketInput.properties).toMatchObject({
      actor: { $ref: "#/components/schemas/ActorRef" },
      human: { type: "boolean" },
      channel: { $ref: "#/components/schemas/ChannelRef" },
    });
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

  it("pauses and stops a Ticket before its worker has registered", async () => {
    const { app, call } = open(undefined, [{ kind: "hang" }]);
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Wait for the library scan",
        idempotencyKey: "http-control",
      }),
    });
    const ticketId = created.body.ticket.id as string;
    const goalId = created.body.goal.id as string;
    expect(app.agent.getGoal(goalId)?.executor).toBe("ticket");

    const paused = await call(`/v1/tickets/${ticketId}/pause`, {
      method: "POST",
    });
    expect(paused.status).toBe(200);
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "paused",
    });
    expect(
      (
        await call(`/v1/tickets/${ticketId}/pause`, {
          method: "POST",
        })
      ).body.code
    ).toBe("invalid_transition");
    const stopped = await call(`/v1/tickets/${ticketId}/stop`, {
      method: "POST",
    });
    expect(stopped.status).toBe(200);
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("adds guidance to a live Ticket for its next checkpoint", async () => {
    const { app, call } = open(undefined, [{ kind: "hang" }]);
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Move the library",
        idempotencyKey: "http-note",
      }),
    });
    const ticketId = created.body.ticket.id as string;
    const goalId = created.body.goal.id as string;

    const noted = await call(`/v1/tickets/${ticketId}/note`, {
      method: "POST",
      body: JSON.stringify({ note: "  Put it in Movies.  " }),
    });
    expect(noted.status).toBe(200);
    expect(noted.body).toMatchObject({
      ticket: { id: ticketId },
      stage: "running",
    });
    expect(app.agent.getGoal(goalId)).toMatchObject({
      guidance: ["Put it in Movies."],
    });

    const empty = await call(`/v1/tickets/${ticketId}/note`, {
      method: "POST",
      body: JSON.stringify({ note: " " }),
    });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("invalid_body");

    await call(`/v1/tickets/${ticketId}/stop`, { method: "POST" });
    await app.agent.waitGoal(goalId);
    const ended = await call(`/v1/tickets/${ticketId}/note`, {
      method: "POST",
      body: JSON.stringify({ note: "Use Movies." }),
    });
    expect(ended.status).toBe(409);
    expect(ended.body.code).toBe("invalid_transition");
  });

  it("resumes a paused Ticket and stops its running Goal", async () => {
    const { app, call, fake } = open(undefined, [{ kind: "hang" }]);
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Resume the library scan",
        idempotencyKey: "http-control-resume",
      }),
    });
    const ticketId = created.body.ticket.id as string;
    const goalId = created.body.goal.id as string;
    await vi.waitFor(() => {
      expect(app.agent.getGoal(goalId)?.activeSubagent).toMatchObject({
        profileName: "ticket-worker",
        status: "running",
      });
    });
    await call(`/v1/tickets/${ticketId}/pause`, { method: "POST" });
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "paused",
    });

    fake.queueTurns([
      { kind: "text", text: "The library scan finished." },
      pass,
    ]);
    const resumed = await call(`/v1/tickets/${ticketId}/resume`, {
      method: "POST",
    });
    expect(resumed.status).toBe(200);
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(
      (
        await call(`/v1/tickets/${ticketId}/stop`, {
          method: "POST",
        })
      ).body.code
    ).toBe("invalid_transition");

    fake.queueTurns([{ kind: "hang" }]);
    const second = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Wait for the second scan",
        idempotencyKey: "http-control-stop",
      }),
    });
    await vi.waitFor(() => {
      expect(
        app.agent.getGoal(second.body.goal.id as string)?.activeSubagent
          ?.profileName
      ).toBe("ticket-worker");
    });
    const stopped = await call(
      `/v1/tickets/${second.body.ticket.id as string}/stop`,
      { method: "POST" }
    );
    expect(stopped.status).toBe(200);
    await expect(
      app.agent.waitGoal(second.body.goal.id as string)
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("retries blocked work under the same Ticket and Goal", async () => {
    const { app, call, fake } = open(undefined, [
      {
        kind: "tools",
        calls: [
          {
            name: "goal_report",
            args: {
              state: "blocked",
              blocker: "The library is read-only",
            },
          },
        ],
      },
      { kind: "text", text: "Blocked until storage is writable." },
    ]);
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Move the library",
        idempotencyKey: "http-retry-blocked",
      }),
    });
    const ticketId = created.body.ticket.id as string;
    const goalId = created.body.goal.id as string;
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "failed",
      blocked: true,
    });
    expect(app.agent.getGoal(goalId)?.error).toBe("The library is read-only");

    fake.queueTurns([{ kind: "text", text: "Finished." }, pass]);
    const retried = await call(`/v1/tickets/${ticketId}/retry`, {
      method: "POST",
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      ticket: { id: ticketId },
      stage: "running",
      goal: {
        id: goalId,
        status: "running",
      },
    });
    const completed = await app.agent.waitGoal(goalId);
    expect(completed).toMatchObject({
      status: "completed",
      iteration: 2,
    });
    expect(completed.blocked).toBeUndefined();
    expect(app.agent.getGoal(goalId)?.status).toBe("completed");
  });

  it("refuses retry after completion or a person stop", async () => {
    const { app, call } = open();
    const completed = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Complete once",
        idempotencyKey: "http-retry-completed",
      }),
    });
    await app.agent.waitGoal(completed.body.goal.id);
    const completedRetry = await call(
      `/v1/tickets/${completed.body.ticket.id}/retry`,
      { method: "POST" }
    );
    expect(completedRetry.status).toBe(409);
    expect(completedRetry.body.code).toBe("invalid_transition");

    const stopped = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Stop before finishing",
        idempotencyKey: "http-retry-stopped",
      }),
    });
    const goalId = stopped.body.goal.id as string;
    await call(`/v1/tickets/${stopped.body.ticket.id}/stop`, {
      method: "POST",
    });
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "cancelled",
    });
    const stoppedRetry = await call(
      `/v1/tickets/${stopped.body.ticket.id}/retry`,
      { method: "POST" }
    );
    expect(stoppedRetry.status).toBe(409);
    expect(stoppedRetry.body.code).toBe("ticket_stopped");
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
    const blockedNote = await call(`/v1/tickets/${"0".repeat(32)}/note`, {
      method: "POST",
      body: JSON.stringify({ note: "Use Movies." }),
    });
    expect(blockedNote.status).toBe(503);
    const blockedControl = await call(`/v1/tickets/${"0".repeat(32)}/stop`, {
      method: "POST",
    });
    expect(blockedControl.status).toBe(503);
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
