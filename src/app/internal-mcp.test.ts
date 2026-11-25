import { afterEach, describe, expect, it } from "vitest";
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
      handler: {
        async handle(request) {
          expect(new URL(request.url).pathname).toBe("/mcp");
          expect(request.headers.get("authorization")).toBe("Bearer test");
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
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { tools: [] },
    });
  });
});
