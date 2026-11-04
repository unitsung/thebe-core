import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import type { FakeQueuedTurn } from "../../testing/runtime/fixtures.ts";

const ORIGIN = "http://127.0.0.1:8787";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("inspect not used");
    },
    getContainerLogs: async () => {
      throw new Error("logs not used");
    },
    getStatusSummary: async () => {
      throw new Error("summary not used");
    },
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

type Body = Record<string, any>;

function reports(
  ...states: Array<{ state: string; summary: string; question?: string }>
): FakeQueuedTurn[] {
  return states.flatMap((args) => [
    { kind: "tools" as const, calls: [{ name: "goal_report", args }] },
    { kind: "text" as const, text: "done" },
  ]);
}

const WORKER_READY = { state: "ready", summary: "Changed it and ran tests." };
const REVIEWER_READY = { state: "ready", summary: "All tests pass." };
const NOW = new Date("2026-11-04T10:00:00.000Z");

function build(agentStoreDir?: string) {
  const fake = createFakeRuntime();
  const app = createThebeApp({
    runtime: fake.runtime,
    provider: provider(),
    now: () => NOW,
    agentStoreDir,
  });
  const call = async (
    path: string,
    init?: RequestInit
  ): Promise<{ status: number; body: Body }> => {
    const res = await app.handler.handle(new Request(`${ORIGIN}${path}`, init));
    return { status: res.status, body: (await res.json()) as Body };
  };
  const post = (path: string, body: unknown = {}) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { fake, app, call, post };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "thebe-tickets-"));
  dirs.push(dir);
  return { dir, ...build(dir) };
}

describe("tickets over HTTP", () => {
  it("advertises the tickets capability in health", async () => {
    const t = build();
    const health = await t.call("/v1/health");
    expect(health.status).toBe(200);
    expect(health.body.capabilities).toEqual({ tickets: true });
    expect(health.body.ok).toBe(true);
  });

  it("starts with no tickets", async () => {
    const t = build();
    expect((await t.call("/v1/tickets")).body).toEqual({ tickets: [] });
    expect((await t.call("/v1/tickets/nope")).status).toBe(404);
  });

  it("creating a goal produces one explicit ticket that wraps it, read-only", async () => {
    const t = build();
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const created = await t.post("/v1/goals", {
      goal: "Tidy the media library",
    });
    expect(created.status).toBe(201);
    const ticketId = String(created.body.ticketId);
    expect(ticketId).toMatch(/^[0-9a-f]{32}$/);
    await t.app.agent.waitGoal(String(created.body.id));

    const list = await t.call("/v1/tickets");
    expect(list.body.tickets).toHaveLength(1);
    const ticket = list.body.tickets[0];
    expect(ticket).toMatchObject({
      id: ticketId,
      title: "Tidy the media library",
      mandate: { strength: "explicit" },
      links: { legacyGoalId: created.body.id },
      stage: { kind: "ended" },
    });
    expect(ticket.links.sessionIds).toEqual([created.body.id]);
    // The wrapped goal's progress is not copied onto the ticket.
    expect(ticket).not.toHaveProperty("status");
    expect(ticket).not.toHaveProperty("goal");

    const one = await t.call(`/v1/tickets/${ticketId}`);
    expect(one.body).toEqual(ticket);

    // The collection is read-only.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        (await t.call("/v1/tickets", { method, body: "{}" })).status
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await t.call(`/v1/tickets/${ticketId}`, { method, body: "{}" })).status
      ).toBeGreaterThanOrEqual(400);
    }
    expect((await t.call("/v1/tickets")).body.tickets).toHaveLength(1);
  });

  it("accepting the same trigger twice yields one ticket and one goal", async () => {
    const t = build();
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const first = await t.post("/v1/goals", {
      goal: "Restart the flaky container",
      triggerId: "chat-message-42",
    });
    const again = await t.post("/v1/goals", {
      goal: "Restart the flaky container",
      triggerId: "chat-message-42",
    });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.ticketId).toBe(first.body.ticketId);
    expect((await t.call("/v1/tickets")).body.tickets).toHaveLength(1);
    expect((await t.call("/v1/goals")).body.goals).toHaveLength(1);

    // A different trigger is a different ticket, even with the same text.
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const other = await t.post("/v1/goals", {
      goal: "Restart the flaky container",
      triggerId: "chat-message-43",
    });
    expect(other.body.ticketId).not.toBe(first.body.ticketId);
    expect((await t.call("/v1/tickets")).body.tickets).toHaveLength(2);
    await t.app.agent.waitGoal(String(first.body.id));
    await t.app.agent.waitGoal(String(other.body.id));
  });

  it("concurrent retries with the same trigger start one goal", async () => {
    const t = build();
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const body = { goal: "Restart the flaky container", triggerId: "retry-1" };
    const [first, second] = await Promise.all([
      t.post("/v1/goals", body),
      t.post("/v1/goals", body),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.ticketId).toBe(first.body.ticketId);
    expect(first.body.ticketId).toMatch(/^[0-9a-f]{32}$/);
    expect((await t.call("/v1/goals")).body.goals).toHaveLength(1);
    expect((await t.call("/v1/tickets")).body.tickets).toHaveLength(1);
    await t.app.agent.waitGoal(String(first.body.id));
  });

  it("treats the same trigger as the same ticket after a restart", async () => {
    const t = await setup();
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const first = await t.post("/v1/goals", {
      goal: "Clean up downloads",
      triggerId: "t-1",
    });
    await t.app.agent.waitGoal(String(first.body.id));

    const next = build(t.dir);
    const again = await next.post("/v1/goals", {
      goal: "Clean up downloads",
      triggerId: "t-1",
    });
    expect(again.status).toBe(200);
    expect(again.body.ticketId).toBe(first.body.ticketId);
    expect((await next.call("/v1/tickets")).body.tickets).toHaveLength(1);
  });

  it("rejects a blank trigger id", async () => {
    const t = build();
    const bad = await t.post("/v1/goals", { goal: "x", triggerId: "   " });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_body");
    expect((await t.call("/v1/tickets")).body.tickets).toEqual([]);
  });

  it("starting a goal on an existing session also produces a ticket", async () => {
    const t = build();
    const session = await t.app.agent.createSession({ title: "mine" });
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const started = await t.post(`/v1/goals/${session.thebeSessionId}`, {
      goal: "Look into the NAS fan noise",
    });
    expect(started.status).toBe(200);
    expect(started.body.ticketId).toMatch(/^[0-9a-f]{32}$/);
    await t.app.agent.waitGoal(session.thebeSessionId);
    const tickets = (await t.call("/v1/tickets")).body.tickets;
    expect(tickets).toHaveLength(1);
    expect(tickets[0].links.legacyGoalId).toBe(session.thebeSessionId);
  });

  it("goal endpoints accept the session id or the ticket id and answer with both", async () => {
    const t = build();
    t.fake.queueTurns(
      reports({
        state: "waiting",
        summary: "Two configs match.",
        question: "Which config should I change?",
      })
    );
    const created = await t.post("/v1/goals", { goal: "Fix the config" });
    const sessionId = String(created.body.id);
    const ticketId = String(created.body.ticketId);
    await t.app.agent.waitGoal(sessionId);

    const bySession = await t.call(`/v1/goals/${sessionId}`);
    const byTicket = await t.call(`/v1/goals/${ticketId}`);
    expect(byTicket.status).toBe(200);
    expect(byTicket.body).toEqual(bySession.body);
    expect(byTicket.body).toMatchObject({ id: sessionId, ticketId });
    expect(
      (await t.call("/v1/goals")).body.goals.map((goal: Body) => goal.ticketId)
    ).toEqual([ticketId]);

    // The ticket's stage is the stage of the goal it wraps: one open question needs the owner.
    expect((await t.call(`/v1/tickets/${ticketId}`)).body.stage).toEqual({
      kind: "person",
      reason: "answer",
    });
    expect((await t.call(`/v1/activity/${sessionId}`)).body.stage).toEqual({
      kind: "person",
      reason: "answer",
    });

    // Answering through the ticket id resumes the same goal.
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const answered = await t.post(`/v1/goals/${ticketId}/answer`, {
      answer: "The one in /etc/app.conf.",
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ id: sessionId, ticketId });
    await t.app.agent.waitGoal(sessionId);
    expect((await t.call(`/v1/tickets/${ticketId}`)).body.stage).toEqual({
      kind: "ended",
    });
    expect(
      (await t.call(`/v1/goals/${ticketId}/log`)).body.events.length
    ).toBeGreaterThan(0);
    expect(
      (await t.call("/v1/goals/ffffffffffffffffffffffffffffffff")).status
    ).toBe(404);
  });

  it("Activity items for the wrapped goal carry the ticket id; others do not", async () => {
    const t = build();
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const created = await t.post("/v1/goals", { goal: "Tidy" });
    await t.app.agent.waitGoal(String(created.body.id));

    const items = (await t.call("/v1/activity")).body.items as Body[];
    const goal = items.find((item) => item.type === "goal")!;
    expect(goal.ticketId).toBe(created.body.ticketId);
    expect(goal.goal.ticketId).toBe(created.body.ticketId);
    expect(items.filter((item) => item.type !== "goal")).toSatisfy(
      (others: Body[]) => others.every((item) => !("ticketId" in item))
    );
    const detail = await t.call(`/v1/activity/${created.body.id}`);
    expect(detail.body.ticketId).toBe(created.body.ticketId);
  });

  it("keeps tickets across a restart and links them to the same goal", async () => {
    const t = await setup();
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const created = await t.post("/v1/goals", { goal: "Persist me" });
    await t.app.agent.waitGoal(String(created.body.id));
    const before = (await t.call("/v1/tickets")).body.tickets;

    const next = build(t.dir);
    expect((await next.call("/v1/tickets")).body.tickets).toEqual(before);
    expect(
      (await next.call(`/v1/goals/${created.body.id}`)).body.ticketId
    ).toBe(created.body.ticketId);
  });

  it("a goal started again on the same session gets its own ticket, and the old one stays ended", async () => {
    let clock = NOW.getTime();
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      now: () => new Date((clock += 1000)),
    });
    const post = async (path: string, body: unknown) =>
      (await (
        await app.handler.handle(
          new Request(`${ORIGIN}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        )
      ).json()) as Body;
    const get = async (path: string) =>
      (await (
        await app.handler.handle(new Request(`${ORIGIN}${path}`))
      ).json()) as Body;

    fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const first = await post("/v1/goals", { goal: "First job" });
    await app.agent.waitGoal(first.id);
    fake.queueTurns(
      reports({ state: "progress", summary: "Working." }, WORKER_READY)
    );
    const second = await post(`/v1/goals/${first.id}`, { goal: "Second job" });
    expect(second.ticketId).not.toBe(first.ticketId);
    const tickets = (await get("/v1/tickets")).tickets as Body[];
    expect(tickets).toHaveLength(2);
    const old = (await get(`/v1/tickets/${first.ticketId}`)) as Body;
    expect(old.stage).toEqual({ kind: "ended" });
    // The goal endpoint answers with the newest ticket for that session.
    expect((await get(`/v1/goals/${first.id}`)).ticketId).toBe(second.ticketId);
    await app.agent.waitGoal(first.id).catch(() => undefined);
  });
});
