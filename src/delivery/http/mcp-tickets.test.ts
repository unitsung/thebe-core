import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeAgent } from "../../agent/index.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createThebeHttpHandler } from "./handler.ts";
import { createDeviceToken, createTokenVerifier } from "./token-store.ts";

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

const readToken = "r".repeat(64);
const writeToken = "w".repeat(64);
const irreversibleToken = "i".repeat(64);

async function setup(
  options: { writesAllowed?: boolean; agentStoreDir?: string } = {}
) {
  const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-tickets-"));
  createDeviceToken({
    configDir,
    name: "Reader",
    scope: "mcp:read",
    generate: () => readToken,
  });
  createDeviceToken({
    configDir,
    name: "Writer",
    scope: "mcp:write",
    generate: () => writeToken,
  });
  createDeviceToken({
    configDir,
    name: "Cleaner",
    scope: "mcp:irreversible",
    generate: () => irreversibleToken,
  });
  const fake = createFakeRuntime();
  const agent = createThebeAgent({
    runtime: fake.runtime,
    provider,
    agentStoreDir: options.agentStoreDir,
    mcpWritesAllowed: options.writesAllowed ?? true,
  });
  const handler = createThebeHttpHandler({
    version: "0.1.0",
    agent,
    token: createTokenVerifier({ configDir, env: {} }),
  });
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    token = readToken
  ) => {
    const response = await handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      })
    );
    return (await response.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
      error?: { code: number; message: string };
    };
  };
  const listTools = async (token: string) => {
    const response = await handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    return body.result.tools.map((tool) => tool.name);
  };
  return { agent, fake, call, listTools };
}

type McpReply = {
  result?: { isError?: boolean; content?: Array<{ text: string }> };
  error?: { code: number; message: string };
};

function text(reply: McpReply) {
  return reply.result?.content?.[0]?.text ?? "";
}

describe("/mcp Ticket tools", () => {
  it("shows read tools to a read token and delegation/reply tools only to writers", async () => {
    const { listTools } = await setup();
    const reader = await listTools(readToken);
    expect(reader).toContain("ticket_list");
    expect(reader).toContain("ticket_get");
    expect(reader).not.toContain("ticket_delegate");
    expect(reader).not.toContain("ticket_reply");
    expect(reader).not.toContain("ticket_control");

    const writer = await listTools(writeToken);
    expect(writer).toEqual(
      expect.arrayContaining([
        "ticket_list",
        "ticket_get",
        "ticket_delegate",
        "ticket_reply",
        "ticket_control",
      ])
    );
  });

  it("refuses delegation for a read token or when the host disables MCP writes", async () => {
    const { call } = await setup();
    const readRefusal = await call("ticket_delegate", {
      task: "Inspect the library",
      idempotencyKey: "read-refusal",
    });
    expect(readRefusal.result?.isError).toBe(true);
    expect(text(readRefusal)).toContain("mcp:write");

    const off = await setup({ writesAllowed: false });
    const hostRefusal = await off.call(
      "ticket_delegate",
      {
        task: "Inspect the library",
        idempotencyKey: "host-refusal",
      },
      writeToken
    );
    expect(hostRefusal.result?.isError).toBe(true);
    expect(text(hostRefusal)).toContain("THEBE_MCP_WRITES");
  });

  it("pauses and stops a Ticket through ticket_control", async () => {
    const { agent, fake, call } = await setup();
    fake.queueTurns([{ kind: "hang" }]);
    const delegated = await call(
      "ticket_delegate",
      {
        task: "Wait for the library scan",
        idempotencyKey: "control-library",
      },
      writeToken
    );
    const created = JSON.parse(text(delegated)) as {
      ticket: { id: string };
      goal: { id: string };
    };

    const paused = await call(
      "ticket_control",
      { ticketId: created.ticket.id, action: "pause" },
      writeToken
    );
    expect(paused.result?.isError).toBeUndefined();
    await expect(agent.waitGoal(created.goal.id)).resolves.toMatchObject({
      status: "paused",
    });

    const stopped = await call(
      "ticket_control",
      { ticketId: created.ticket.id, action: "stop" },
      writeToken
    );
    expect(stopped.result?.isError).toBeUndefined();
    await expect(agent.waitGoal(created.goal.id)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("keeps Ticket reads available while quiesced and refuses new delegation", async () => {
    const { agent, call } = await setup();
    await agent.quiesce();

    const listed = await call("ticket_list", {}, readToken);
    expect(listed.error).toBeUndefined();
    expect(JSON.parse(text(listed))).toEqual({ tickets: [] });

    const refused = await call(
      "ticket_delegate",
      {
        task: "Inspect the library",
        idempotencyKey: "quiesced",
      },
      writeToken
    );
    expect(refused.error?.code).toBe(-32003);
  });

  it("delegates idempotently and carries a question through reply to a verified receipt", async () => {
    const { agent, fake, call } = await setup();
    fake.queueTurns([
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
    const delegated = await call(
      "ticket_delegate",
      {
        task: "Move the selected library",
        idempotencyKey: "delegate-library",
        criteria: ["the selected library is in its new location"],
      },
      writeToken
    );
    const first = JSON.parse(text(delegated)) as {
      ticket: { id: string };
      goal: { id: string };
      reused: boolean;
    };
    expect(first.reused).toBe(false);

    const retried = await call(
      "ticket_delegate",
      {
        task: "Move the selected library",
        idempotencyKey: "delegate-library",
      },
      writeToken
    );
    const second = JSON.parse(text(retried)) as {
      ticket: { id: string };
      goal: { id: string };
      reused: boolean;
    };
    expect(second).toMatchObject({
      reused: true,
      ticket: { id: first.ticket.id },
      goal: { id: first.goal.id },
    });
    expect(await agent.listTickets()).toHaveLength(1);

    await vi.waitFor(() => {
      expect(agent.getGoal(first.goal.id)?.attention?.kind).toBe("answer");
    });
    const pending = await call(
      "ticket_get",
      { ticketId: first.ticket.id },
      readToken
    );
    const view = JSON.parse(text(pending)) as {
      stage: string;
      goal: { attention: { id: string; question: string } };
    };
    expect(view.stage).toBe("attention");
    expect(view.goal.attention.question).toBe("Which library should I move?");

    fake.queueTurns([
      { kind: "text", text: "Moved Movies and checked the destination." },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: the selected library is now in its new location\nREMAINING: none",
      },
    ]);
    const replied = await call(
      "ticket_reply",
      {
        ticketId: first.ticket.id,
        attentionId: view.goal.attention.id,
        answer: "Movies",
      },
      writeToken
    );
    expect(replied.result?.isError).toBeUndefined();
    await agent.waitGoal(first.goal.id);

    const completed = await call(
      "ticket_get",
      { ticketId: first.ticket.id },
      readToken
    );
    const done = JSON.parse(text(completed)) as {
      stage: string;
      receipt: {
        complete: boolean;
        finalReport: string;
      };
    };
    expect(done).toMatchObject({
      stage: "completed",
      receipt: {
        complete: true,
        finalReport: expect.stringContaining("VERDICT: pass"),
      },
    });
  });

  it("lets a writer approve one ordinary pending worker call", async () => {
    const { agent, fake, call } = await setup();
    fake.queueTurns([
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
    const delegated = await call(
      "ticket_delegate",
      {
        task: "Clean the temporary workspace",
        idempotencyKey: "delegate-bash",
      },
      writeToken
    );
    const created = JSON.parse(text(delegated)) as {
      ticket: { id: string };
      goal: { id: string };
    };
    await vi.waitFor(() => {
      expect(agent.listPendingPermissions()).toHaveLength(1);
    });
    const pending = agent.listPendingPermissions()[0]!;
    const viewReply = await call(
      "ticket_get",
      { ticketId: created.ticket.id },
      readToken
    );
    const view = JSON.parse(text(viewReply)) as {
      stage: string;
      pendingPermissions: Array<{ id: string; toolName: string }>;
    };
    expect(view.stage).toBe("attention");
    expect(view.pendingPermissions[0]).toMatchObject({
      id: pending.id,
      toolName: "write",
    });

    const allowed = await call(
      "ticket_reply",
      {
        ticketId: created.ticket.id,
        permissionId: pending.id,
        permissionDecision: "allow",
      },
      writeToken
    );
    expect(allowed.result?.isError).toBeUndefined();
    await expect(agent.waitGoal(created.goal.id)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("requires mcp:irreversible before approving an arbitrary shell call", async () => {
    const { agent, fake, call } = await setup();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [
          {
            name: "bash",
            args: { command: "rm -rf /tmp/example" },
          },
          {
            name: "goal_report",
            args: {
              state: "blocked",
              blocker: "cleanup needs a separate decision",
            },
          },
        ],
      },
    ]);
    const delegated = await call(
      "ticket_delegate",
      {
        task: "Clean the temporary workspace",
        idempotencyKey: "delegate-bash",
      },
      writeToken
    );
    const created = JSON.parse(text(delegated)) as {
      ticket: { id: string };
      goal: { id: string };
    };
    await vi.waitFor(() => {
      expect(agent.listPendingPermissions()).toHaveLength(1);
    });
    const pending = agent.listPendingPermissions()[0]!;

    const refused = await call(
      "ticket_reply",
      {
        ticketId: created.ticket.id,
        permissionId: pending.id,
        permissionDecision: "allow",
      },
      writeToken
    );
    expect(refused.result?.isError).toBe(true);
    expect(text(refused)).toContain("mcp:irreversible");

    const allowed = await call(
      "ticket_reply",
      {
        ticketId: created.ticket.id,
        permissionId: pending.id,
        permissionDecision: "allow",
      },
      irreversibleToken
    );
    expect(allowed.result?.isError).toBeUndefined();
    await expect(agent.waitGoal(created.goal.id)).resolves.toMatchObject({
      status: "failed",
      blocked: true,
    });
  });

  it("finds the same persisted Ticket after a Core restart", async () => {
    const agentStoreDir = await mkdtemp(
      join(tmpdir(), "thebe-mcp-ticket-store-")
    );
    const first = await setup({ agentStoreDir });
    first.fake.queueTurns([
      { kind: "text", text: "Inspected the library." },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: library inspected\nREMAINING: none",
      },
    ]);
    const delegated = await first.call(
      "ticket_delegate",
      {
        task: "Inspect the library",
        idempotencyKey: "survive-restart",
        observe: true,
      },
      writeToken
    );
    const created = JSON.parse(text(delegated)) as {
      ticket: { id: string };
      goal: { id: string };
    };
    await first.agent.waitGoal(created.goal.id);

    const second = await setup({ agentStoreDir });
    const retried = await second.call(
      "ticket_delegate",
      {
        task: "Inspect the library",
        idempotencyKey: "survive-restart",
        observe: true,
      },
      writeToken
    );
    const found = JSON.parse(text(retried)) as {
      ticket: { id: string };
      goal: { id: string };
      reused: boolean;
    };
    expect(found).toMatchObject({
      reused: true,
      ticket: { id: created.ticket.id },
      goal: { id: created.goal.id },
    });
  });
});
