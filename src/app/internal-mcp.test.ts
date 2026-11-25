import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED } from "../agent/security/redaction.ts";
import {
  startInternalMcpBridge,
  type InternalMcpBridge,
} from "./internal-mcp.ts";

let bridge: InternalMcpBridge | undefined;

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

describe("internal DSH MCP bridge", () => {
  it("forwards MCP requests to the same in-process handler", async () => {
    bridge = await startInternalMcpBridge({
      token: "core-token",
      handler: {
        async handle(request) {
          expect(new URL(request.url).pathname).toBe("/mcp");
          expect(request.headers.get("authorization")).toBe(
            "Bearer core-token"
          );
          expect(await request.text()).toContain('"tools/list"');
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
            { headers: { "content-type": "application/json" } }
          );
        },
      },
    });

    const response = await fetch(bridge.url, {
      method: "POST",
      headers: {
        authorization: "Bearer core-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { tools: [] },
    });
  });

  it("serves session-scoped Core tools with the same token and approval handler", async () => {
    const permission = vi.fn(async () => "allow" as const);
    const emitted: string[] = [];
    bridge = await startInternalMcpBridge({
      token: "core-token",
      handler: {
        async handle() {
          throw new Error("global handler should not receive session tools");
        },
      },
    });
    const tools = bridge.registerSession("session-1", {
      customTools: [
        {
          name: "goal_report",
          label: "Goal report",
          description: "Report checkpoint state",
          parameters: {
            type: "object",
            properties: { state: { type: "string" } },
          },
          requiresApproval: true,
          execute: async (_id, params) => ({
            content: [{ type: "text", text: JSON.stringify(params) }],
          }),
        },
      ],
      permissionHandler: { request: permission },
      emit: (event) => emitted.push(event.type),
    });

    const list = await fetch(tools.url, {
      method: "POST",
      headers: {
        authorization: "Bearer core-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await expect(list.json()).resolves.toMatchObject({
      result: { tools: [{ name: "goal_report" }] },
    });

    const call = await fetch(tools.url, {
      method: "POST",
      headers: {
        authorization: "Bearer core-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "goal_report",
          arguments: { state: "ready" },
        },
      }),
    });
    await expect(call.json()).resolves.toMatchObject({
      result: {
        content: [{ type: "text", text: '{"state":"ready"}' }],
      },
    });
    expect(permission).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "goal_report",
        args: { state: "ready" },
      })
    );
    expect(emitted).toEqual(["permission_requested"]);
  });

  it("aborts an active session tool when the session is unregistered", async () => {
    bridge = await startInternalMcpBridge({
      token: "core-token",
      handler: {
        async handle() {
          throw new Error("global handler should not receive session tools");
        },
      },
    });
    let started!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: () => void;
    const executionAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const tools = bridge.registerSession("session-cancelled", {
      customTools: [
        {
          name: "long_running",
          label: "Long running",
          description: "Wait until cancelled",
          parameters: { type: "object", properties: {} },
          execute: async (_id, _params, signal) => {
            started();
            await new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  aborted();
                  reject(new Error("cancelled"));
                },
                { once: true }
              );
            });
            throw new Error("unreachable");
          },
        },
      ],
      emit: () => {},
    });

    const response = fetch(tools.url, {
      method: "POST",
      headers: {
        authorization: "Bearer core-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "long_running",
          arguments: {},
        },
      }),
    });
    await executionStarted;
    bridge.unregisterSession("session-cancelled");
    await executionAborted;

    await expect((await response).json()).resolves.toMatchObject({
      result: {
        content: [{ type: "text", text: "cancelled" }],
        isError: true,
      },
    });
  });

  it("does not execute an approved tool after its session is unregistered", async () => {
    bridge = await startInternalMcpBridge({
      token: "core-token",
      handler: {
        async handle() {
          throw new Error("global handler should not receive session tools");
        },
      },
    });
    let approvalRequested!: () => void;
    const waitingForApproval = new Promise<void>((resolve) => {
      approvalRequested = resolve;
    });
    let approve!: (decision: "allow") => void;
    const approval = new Promise<"allow">((resolve) => {
      approve = resolve;
    });
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "executed" }],
    }));
    const tools = bridge.registerSession("session-approval-cancelled", {
      customTools: [
        {
          name: "approval_bound",
          label: "Approval bound",
          description: "Wait for approval before execution",
          parameters: { type: "object", properties: {} },
          requiresApproval: true,
          execute,
        },
      ],
      permissionHandler: {
        request: async () => {
          approvalRequested();
          return approval;
        },
      },
      emit: () => {},
    });

    const response = fetch(tools.url, {
      method: "POST",
      headers: {
        authorization: "Bearer core-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "approval_bound",
          arguments: {},
        },
      }),
    });
    await waitingForApproval;
    bridge.unregisterSession("session-approval-cancelled");
    approve("allow");

    await expect((await response).json()).resolves.toMatchObject({
      result: {
        content: [{ type: "text", text: "cancelled" }],
        isError: true,
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("publishes a redacted approval event only after preflight asks", async () => {
    bridge = await startInternalMcpBridge({
      token: "core-token",
      handler: {
        async handle() {
          throw new Error("global handler should not receive session tools");
        },
      },
    });
    const emitted: Array<{ type: string; argsSummary?: string }> = [];
    let preflightStarted!: () => void;
    const waitingForPreflight = new Promise<void>((resolve) => {
      preflightStarted = resolve;
    });
    let finishPreflight!: (decision: "ask") => void;
    const preflight = new Promise<"ask">((resolve) => {
      finishPreflight = resolve;
    });
    const request = vi.fn(async () => "allow" as const);
    const tools = bridge.registerSession("session-delayed-preflight", {
      customTools: [
        {
          name: "delayed_preflight",
          label: "Delayed preflight",
          description: "Wait for preflight before approval",
          parameters: { type: "object", properties: {} },
          requiresApproval: true,
          execute: async () => ({
            content: [{ type: "text", text: "executed" }],
          }),
        },
      ],
      permissionHandler: {
        preflight: async () => {
          preflightStarted();
          return preflight;
        },
        request,
      },
      emit: (event) => emitted.push(event),
    });

    const response = fetch(tools.url, {
      method: "POST",
      headers: {
        authorization: "Bearer core-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "delayed_preflight",
          arguments: { command: "API_TOKEN=super-secret" },
        },
      }),
    });
    await waitingForPreflight;
    expect(emitted).toEqual([]);
    finishPreflight("ask");

    await expect((await response).json()).resolves.toMatchObject({
      result: { content: [{ type: "text", text: "executed" }] },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(emitted).toMatchObject([
      {
        type: "permission_requested",
        argsSummary: expect.stringContaining(`API_TOKEN=${REDACTED}`),
      },
    ]);
    expect(JSON.stringify(emitted)).not.toContain("super-secret");
  });

  it("uses a unique permission id for each session-local call", async () => {
    bridge = await startInternalMcpBridge({
      token: "core-token",
      handler: {
        async handle() {
          throw new Error("global handler should not receive session tools");
        },
      },
    });
    const permissionIds: string[] = [];
    const register = (sessionId: string) =>
      bridge!.registerSession(sessionId, {
        customTools: [
          {
            name: "shared_tool",
            label: "Shared tool",
            description: "A tool shared by multiple sessions",
            parameters: { type: "object", properties: {} },
            requiresApproval: true,
            execute: async () => ({
              content: [{ type: "text", text: "executed" }],
            }),
          },
        ],
        permissionHandler: {
          request: async (request) => {
            permissionIds.push(request.permissionId);
            return "allow";
          },
        },
        emit: () => {},
      });
    const first = register("session-a");
    const second = register("session-b");
    const call = (url: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer core-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "shared_tool",
            arguments: {},
          },
        }),
      });

    await Promise.all([call(first.url), call(second.url)]);
    expect(permissionIds).toHaveLength(2);
    expect(new Set(permissionIds).size).toBe(2);
  });

  it("runs session cleanup when a binding is replaced or removed", async () => {
    bridge = await startInternalMcpBridge({
      token: "core-token",
      handler: {
        async handle() {
          throw new Error("global handler should not receive session tools");
        },
      },
    });
    const cleanup = vi.fn(async () => {});
    bridge.registerSession("session-cleanup", {
      customTools: [],
      emit: () => {},
      cleanup,
    });
    bridge.registerSession("session-cleanup", {
      customTools: [],
      emit: () => {},
      cleanup,
    });
    bridge.unregisterSession("session-cleanup");

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
  });
});
