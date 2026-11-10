import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import type { McpRegistry } from "../../agent/extensions/mcp.ts";
import type { EnabledResource } from "../../agent/runtime/interface.ts";
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

function open(
  agentStoreDir?: string,
  fake = createFakeRuntime(),
  extra: {
    mcp?: McpRegistry;
    enabledResources?: EnabledResource[];
  } = {}
) {
  const app = createThebeApp({
    runtime: fake.runtime,
    provider,
    agentStoreDir,
    ...extra,
  });
  const call = async (path: string, init?: RequestInit) => {
    const response = await app.handler.handle(
      new Request(`http://127.0.0.1:8787${path}`, {
        ...init,
        headers: { "content-type": "application/json" },
      })
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  };
  return { app, fake, call };
}

describe("main Session", () => {
  it("starts lazily and exposes only Decision and Ticket tools", async () => {
    const mcp: McpRegistry = {
      listTools: async () => [],
      listServers: async () => [],
      setServerEnabled: async () => undefined,
      runtimeServers: () => [
        {
          name: "external",
          command: "external",
          enabled: true,
        },
      ],
      invokeTool: async () => undefined,
      close() {},
    };
    const { app, fake, call } = open(undefined, undefined, {
      mcp,
      enabledResources: [
        {
          kind: "skill",
          identity: "main-session-test",
          source: "/tmp/main-session-test",
          version: "1",
        },
      ],
    });
    expect((await call("/v1/main-session")).body).toEqual({
      id: "thebe-main",
      initialized: false,
    });

    fake.queueTurns([{ kind: "text", text: "Thebe is here." }]);
    const prompted = await call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({ text: "Hello" }),
    });
    expect(prompted.status).toBe(200);
    expect(prompted.body).toMatchObject({
      text: "Thebe is here.",
      thebeSessionId: "thebe-main",
    });

    const info = await call("/v1/main-session");
    expect(info.body).toMatchObject({
      id: "thebe-main",
      initialized: true,
      session: {
        thebeSessionId: "thebe-main",
        labels: { kind: "main", "thebe.main": "true" },
      },
    });
    const state = fake.snapshot(info.body.session.runtimeSessionId);
    expect(state.builtinTools).toEqual([]);
    expect(state.mcp).toBeUndefined();
    expect(state.enabledResources).toEqual([]);
    expect(state.tools.map((tool) => tool.name)).toEqual([
      "session_search",
      "decision_list",
      "decision_get",
      "decision_accept",
      "decision_attach",
      "ticket_list",
      "ticket_get",
      "ticket_delegate",
      "ticket_reply",
      "ticket_note",
      "ticket_control",
    ]);
    expect(state.toolsRequiringApproval).toEqual(
      expect.arrayContaining([
        "decision_accept",
        "decision_attach",
        "ticket_delegate",
        "ticket_reply",
        "ticket_note",
        "ticket_control",
      ])
    );
    expect(
      state.tools.find((tool) => tool.name === "ticket_control")?.parameters
    ).toMatchObject({
      properties: {
        action: {
          enum: ["pause", "resume", "stop", "retry"],
        },
      },
    });
    expect(state.tools.map((tool) => tool.name)).not.toContain("bash");
    expect(state.tools.map((tool) => tool.name)).not.toContain("write");
    expect(state.tools.map((tool) => tool.name)).not.toContain("edit");
    expect(await app.agent.getMainSession()).toMatchObject({
      thebeSessionId: "thebe-main",
      status: "idle",
    });
  });

  it("recalls an earlier Core Session without taking over the active conversation", async () => {
    const { app, fake, call } = open();
    fake.queueTurns([{ kind: "text", text: "Use restic nightly." }]);
    const previous = await call("/v1/session", {
      method: "POST",
      body: JSON.stringify({ title: "Backup plan" }),
    });
    await call(`/v1/session/${previous.body.thebeSessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "How should backups run?" }),
    });

    fake.queueTurns([
      {
        kind: "tools",
        calls: [
          {
            name: "session_search",
            args: { query: "restic backups" },
          },
        ],
      },
      { kind: "text", text: "You chose restic nightly." },
    ]);
    const prompted = await call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({ text: "What did we decide about backups?" }),
    });
    expect(prompted.status).toBe(200);
    expect(prompted.body.tools).toContain("session_search");

    const info = await call("/v1/main-session");
    const state = fake.snapshot(info.body.session.runtimeSessionId);
    const recalled = state.messages.find(
      (message) =>
        message.role === "tool" && message.toolName === "session_search"
    );
    expect(recalled?.text).toContain(previous.body.thebeSessionId);
    expect(recalled?.text).toContain("Use restic nightly.");
    expect(app.agent.lastThebeSessionId()).toBe("thebe-main");
  });

  it("applies model and thinking selections to the first main Session turn", async () => {
    const { fake, call } = open();
    fake.queueTurns([{ kind: "text", text: "Configured." }]);

    const prompted = await call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({
        text: "Hello",
        model: { providerId: "deepseek", modelId: "deepseek-reasoner" },
        thinking: "high",
      }),
    });

    expect(prompted.status).toBe(200);
    const info = await call("/v1/main-session");
    const state = fake.snapshot(info.body.session.runtimeSessionId);
    expect(state.model).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
    });
    expect(state.thinkingLevel).toBe("high");
  });

  it("rejects invalid runtime selections before creating the main Session", async () => {
    const { call } = open();

    const badModel = await call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({
        text: "Hello",
        model: { providerId: "deepseek" },
      }),
    });
    const badThinking = await call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({ text: "Hello", thinking: "extreme" }),
    });

    expect(badModel.status).toBe(400);
    expect(badThinking.status).toBe(400);
    expect((await call("/v1/main-session")).body.initialized).toBe(false);
  });

  it("refuses a thinking level the selected model cannot apply", async () => {
    const { call } = open();

    const prompted = await call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({
        text: "Hello",
        model: { providerId: "fake", modelId: "fake-2" },
        thinking: "high",
      }),
    });

    expect(prompted).toMatchObject({
      status: 400,
      body: {
        code: "thinking_unsupported",
        error: "thinking level high was applied as off",
      },
    });
  });

  it("lets the main Session read Tickets through its own tool", async () => {
    const { fake, call } = open();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [{ name: "ticket_list", args: {} }],
      },
      { kind: "text", text: "There are no tasks." },
    ]);
    const prompted = await call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({ text: "What is running?" }),
    });
    expect(prompted.status).toBe(200);
    expect(prompted.body).toMatchObject({
      text: "There are no tasks.",
      tools: ["ticket_list"],
    });
  });

  it("lets the main Session inspect Eval candidates", async () => {
    const { fake, call } = open();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [
          {
            name: "decision_list",
            args: { candidateOnly: true },
          },
        ],
      },
      { kind: "text", text: "There are no candidates." },
    ]);
    const prompted = await call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({ text: "Is there anything you would act on?" }),
    });
    expect(prompted.status).toBe(200);
    expect(prompted.body).toMatchObject({
      text: "There are no candidates.",
      tools: ["decision_list"],
    });
    const info = await call("/v1/main-session");
    const state = fake.snapshot(info.body.session.runtimeSessionId);
    const result = state.messages.find(
      (message) =>
        message.role === "tool" && message.toolName === "decision_list"
    );
    expect(result?.text).toContain(JSON.stringify({ decisions: [] }));
    expect(result?.text).toContain('<tool_output tool="decision_list">');
  });

  it("attributes a delegated Ticket to the person, not to an MCP caller", async () => {
    const { app, fake, call } = open();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [
          {
            name: "ticket_delegate",
            args: {
              task: "Verify the backup set",
              idempotencyKey: "main-session-backup-check",
              observe: true,
              maxIterations: 1,
            },
          },
        ],
      },
    ]);

    const prompted = call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({ text: "Check the backups in the background." }),
    });
    await vi.waitFor(() => {
      expect(app.agent.pendingPermissionIds()).toHaveLength(1);
    });
    const permissionId = app.agent.pendingPermissionIds()[0]!;
    expect(
      (
        await call(`/v1/permissions/${permissionId}/resolve`, {
          method: "POST",
          body: JSON.stringify({ response: "allow" }),
        })
      ).status
    ).toBe(200);
    expect((await prompted).status).toBe(200);

    const ticket = (await app.agent.listTickets()).find(
      (item) => item.title === "Verify the backup set"
    );
    expect(ticket).toMatchObject({
      mandate: {
        strength: "explicit",
        decidedBy: "direct",
        requester: "chat",
      },
    });
    expect(ticket?.links.requestId).toMatch(/^[a-f0-9]{32}$/);
    const goalId = ticket?.links.legacyGoalId;
    expect(goalId).toBeDefined();
    await expect(app.agent.getSession(goalId!)).resolves.toMatchObject({
      labels: {
        ticketRequester: "chat",
        ticketRequestId: ticket?.links.requestId,
        mainSessionRequester: "chat",
        mainSessionRequestId: ticket?.links.requestId,
      },
    });
  });

  it("restores the same Session and transcript after Core recreation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-main-session-"));
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "First answer." }]);
    const first = open(dir, fake);
    const created = await first.call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({ text: "First question" }),
    });
    expect(created.status).toBe(200);

    fake.queueTurns([{ kind: "text", text: "Second answer." }]);
    const second = open(dir, fake);
    const before = await second.call("/v1/main-session");
    expect(before.body).toMatchObject({
      id: "thebe-main",
      initialized: true,
      session: { thebeSessionId: "thebe-main" },
    });
    const resumed = await second.call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({ text: "Second question" }),
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({
      text: "Second answer.",
      thebeSessionId: "thebe-main",
    });
    const resumedState = fake.snapshot(
      String(before.body.session.runtimeSessionId)
    );
    expect(resumedState.builtinTools).toEqual([]);
    expect(resumedState.tools.map((tool) => tool.name)).toEqual([
      "session_search",
      "decision_list",
      "decision_get",
      "decision_accept",
      "decision_attach",
      "ticket_list",
      "ticket_get",
      "ticket_delegate",
      "ticket_reply",
      "ticket_note",
      "ticket_control",
    ]);
    await expect(second.app.agent.loadMessages("thebe-main")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "First question" }),
        expect.objectContaining({ role: "assistant", text: "First answer." }),
        expect.objectContaining({ role: "user", text: "Second question" }),
        expect.objectContaining({ role: "assistant", text: "Second answer." }),
      ])
    );
  });

  it("documents the lazy entry point, message and interrupt routes", async () => {
    const { call } = open();
    const spec = await call("/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.paths).toMatchObject({
      "/v1/main-session": { get: expect.any(Object) },
      "/v1/main-session/messages": { post: expect.any(Object) },
      "/v1/main-session/interrupt": { post: expect.any(Object) },
    });
    expect(spec.body.components.schemas).toMatchObject({
      MainSession: expect.any(Object),
      MainSessionPromptRequest: expect.any(Object),
      MainSessionPromptResponse: expect.any(Object),
    });
  });

  it("keeps reads available and refuses prompts while quiesced", async () => {
    const { app, call } = open();
    await app.agent.quiesce();
    expect((await call("/v1/main-session")).status).toBe(200);
    const blocked = await call("/v1/main-session/messages", {
      method: "POST",
      body: JSON.stringify({ text: "Hello" }),
    });
    expect(blocked.status).toBe(503);
  });
});
