import { afterEach, describe, expect, it, vi } from "vitest";
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
  });
});
