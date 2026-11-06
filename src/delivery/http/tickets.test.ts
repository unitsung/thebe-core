import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

function open(agentStoreDir?: string) {
  const fake = createFakeRuntime();
  fake.queueTurns([{ kind: "text", text: "GOAL_STATUS: complete" }, pass]);
  const app = createThebeApp({
    runtime: fake.runtime,
    provider,
    agentStoreDir,
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

  it("is read-only and answers 404 for an unknown or malformed id", async () => {
    const { call } = open();
    expect(
      (await call("/v1/tickets", { method: "POST", body: "{}" })).status
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
});
