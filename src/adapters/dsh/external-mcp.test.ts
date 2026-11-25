import { describe, expect, it, vi } from "vitest";
import type { RuntimeMcpOptions } from "../../agent/runtime/interface.ts";
import {
  createExternalMcpSession,
  type ExternalMcpClient,
} from "./external-mcp.ts";

function fixture(options?: { permission?: boolean }) {
  const client: ExternalMcpClient = {
    listTools: vi.fn(async () => ({
      tools: [
        {
          name: "lookup",
          description: "Look something up",
          inputSchema: {
            type: "object" as const,
            properties: { query: { type: "string" } },
          },
        },
      ],
    })),
    callTool: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "TOKEN=external-secret" }],
      structuredContent: { token: "external-secret" },
      isError: false,
    })),
    close: vi.fn(async () => {}),
  };
  const beforeCall = vi.fn(async () => undefined);
  const afterCall = vi.fn(async () => {});
  const mcp: RuntimeMcpOptions = {
    servers: () => [
      {
        name: "demo",
        url: "https://mcp.example.test",
        enabled: true,
        permission: options?.permission ? "confirm" : "read",
        readTools: ["lookup"],
      },
    ],
    beforeCall,
    afterCall,
  };
  return { client, beforeCall, afterCall, mcp };
}

describe("DSH external MCP adapter", () => {
  it("bridges external tools through Core policy and result redaction", async () => {
    const f = fixture();
    const emitted: string[] = [];
    const session = await createExternalMcpSession({
      mcp: f.mcp,
      cwd: "/workspace",
      connectClient: async () => f.client,
      emit: (event) => emitted.push(event.type),
    });
    const tool = session.tools.find(
      (item) => item.name === "mcp__demo__lookup"
    );
    expect(tool).toBeDefined();

    const result = await tool!.execute("call-1", { query: "hello" });

    expect(f.beforeCall).toHaveBeenCalledWith({
      toolName: "mcp__demo__lookup",
      toolCallId: "call-1",
      input: { query: "hello" },
    });
    expect(f.client.callTool).toHaveBeenCalledWith(
      { name: "lookup", arguments: { query: "hello" } },
      expect.objectContaining({})
    );
    expect(JSON.stringify(result)).not.toContain("external-secret");
    expect(result.content[0]?.text).toContain("***REDACTED***");
    expect(f.afterCall).toHaveBeenCalledWith(
      {
        toolName: "mcp__demo__lookup",
        toolCallId: "call-1",
        input: { query: "hello" },
      },
      expect.objectContaining({ isError: false, redacted: true })
    );
    expect(emitted).toEqual([]);
    await session.close();
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("asks the owning session before a configured confirmation tool runs", async () => {
    const f = fixture({ permission: true });
    const emitted: Array<{ type: string; permissionId?: string }> = [];
    const request = vi.fn(async () => "allow" as const);
    const session = await createExternalMcpSession({
      mcp: f.mcp,
      cwd: "/workspace",
      connectClient: async () => f.client,
      permissionHandler: { request },
      emit: (event) => emitted.push(event),
    });
    const tool = session.tools.find(
      (item) => item.name === "mcp__demo__lookup"
    );

    await tool!.execute("call-2", { query: "approval" });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "mcp__demo__lookup",
        toolCallId: "call-2",
        args: { query: "approval" },
      })
    );
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "permission_requested",
        permissionId: expect.any(String),
      }),
    ]);
  });
});
