import { describe, expect, it, vi } from "vitest";
import type { CreateRuntimeSessionOptions } from "./runtime/interface.ts";
import { createThebeApp } from "../app/create.ts";
import { createFakeRuntime } from "../testing/runtime/index.ts";

function emptyProvider() {
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

function captureCreates(fake: ReturnType<typeof createFakeRuntime>) {
  const rows: CreateRuntimeSessionOptions[] = [];
  const runtime = {
    ...fake.runtime,
    async createSession(options: CreateRuntimeSessionOptions) {
      rows.push(options);
      return fake.runtime.createSession(options);
    },
  };
  return { rows, runtime };
}

describe("App control on the Core route", () => {
  it("gives both the main and ordinary Sessions the App-control tools", async () => {
    const fake = createFakeRuntime();
    const captured = captureCreates(fake);
    fake.queueTurns([
      { kind: "text", text: "main" },
      { kind: "text", text: "ordinary" },
    ]);
    const app = createThebeApp({
      runtime: captured.runtime,
      provider: emptyProvider(),
    });

    await app.agent.askMainSession({ text: "hello" });
    const session = await app.agent.createSession();
    await app.agent.prompt("hello", { thebeSessionId: session.thebeSessionId });

    const names = (options: CreateRuntimeSessionOptions) =>
      options.customTools.map((tool) => tool.name);
    for (const options of captured.rows) {
      expect(names(options)).toEqual(
        expect.arrayContaining([
          "app_settings_read",
          "app_settings_update",
          "app_service_add",
          "app_open",
        ])
      );
    }
    const write = captured.rows[0]!.customTools.find(
      (tool) => tool.name === "app_settings_update"
    );
    expect(write?.requiresApproval).toBe(true);
  });

  it("lets the App fetch a pending call and returns its result to the model", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "app_settings_read" }] },
      { kind: "text", text: "the App answered" },
    ]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });

    const turn = app.agent.askMainSession({ text: "read the App settings" });
    let requestId = "";
    await vi.waitFor(() => {
      const event = app.agent
        .events("thebe-main")
        .find((row) => row.type === "client_tool_requested");
      expect(event).toBeDefined();
      requestId = (event as { requestId: string }).requestId;
    });

    const listed = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session/thebe-main/client-tools")
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      requests: [
        {
          id: requestId,
          toolName: "app_settings_read",
        },
      ],
    });

    const pending = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/thebe-main/client-tools/${requestId}`
      )
    );
    expect(pending.status).toBe(200);
    await expect(pending.json()).resolves.toMatchObject({
      id: requestId,
      toolName: "app_settings_read",
      arguments: {},
    });

    const answered = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/thebe-main/client-tools/${requestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ok: true,
            summary: "Read App settings",
            data: { theme: "dark" },
          }),
        }
      )
    );
    expect(answered.status).toBe(200);
    await expect(answered.json()).resolves.toEqual({ ok: true });

    await expect(turn).resolves.toMatchObject({
      text: "the App answered",
      tools: ["app_settings_read"],
    });
    const [toolResult] = fake.inboundToolResults();
    expect(toolResult).toMatchObject({
      toolName: "app_settings_read",
      isError: false,
    });
    expect(toolResult!.text).toContain("Read App settings");
    expect(toolResult!.text).toContain("dark");
  });

  it("keeps App writes behind Core approval before the App is asked to run them", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [
          {
            name: "app_settings_update",
            args: { setting: "theme", value: "dark" },
          },
        ],
      },
      { kind: "text", text: "changed" },
    ]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: emptyProvider(),
      permissionMode: "manual",
    });

    const turn = app.agent.askMainSession({ text: "use dark mode" });
    let permissionId = "";
    await vi.waitFor(() => {
      const event = app.agent
        .events("thebe-main")
        .find((row) => row.type === "permission_requested");
      expect(event).toBeDefined();
      permissionId = (event as { permissionId: string }).permissionId;
    });
    expect(
      app.agent
        .events("thebe-main")
        .some((row) => row.type === "client_tool_requested")
    ).toBe(false);

    await app.agent.resolvePermission("thebe-main", permissionId, {
      response: "allow",
    });
    let requestId = "";
    await vi.waitFor(() => {
      const event = app.agent
        .events("thebe-main")
        .find((row) => row.type === "client_tool_requested");
      expect(event).toBeDefined();
      requestId = (event as { requestId: string }).requestId;
    });
    await app.agent.resolveClientToolRequest("thebe-main", requestId, {
      ok: true,
      summary: "Changed theme",
    });

    await expect(turn).resolves.toMatchObject({ text: "changed" });
  });

  it("does not give a subagent the person's App-control tools", async () => {
    const fake = createFakeRuntime();
    const captured = captureCreates(fake);
    fake.queueTurns([{ kind: "text", text: "child done" }]);
    const app = createThebeApp({
      runtime: captured.runtime,
      provider: emptyProvider(),
    });
    const parent = await app.agent.createSession({ title: "parent" });

    await app.agent.spawnSubagent({
      profileName: "diagnostics",
      taskPrompt: "read only",
      parentSessionId: parent.thebeSessionId,
    });

    const child = captured.rows.at(-1)!;
    expect(child.customTools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        "app_settings_read",
        "app_settings_update",
        "app_service_add",
        "app_open",
      ])
    );
  });
});
