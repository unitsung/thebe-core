import { describe, expect, it } from "vitest";
import { createThebeHttpHandler } from "./handler.ts";
import { createMcpOnlyHandler } from "./mcp-only.ts";

const gateway = createMcpOnlyHandler(
  createThebeHttpHandler({ version: "t", token: "secret" })
);
const request = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:8788${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });

describe("the /mcp-only gateway handler", () => {
  it("serves /mcp, still behind the token", async () => {
    expect((await gateway.handle(request("/mcp"))).status).toBe(401);
    const ok = await gateway.handle(
      request("/mcp", { Authorization: "Bearer secret" })
    );
    expect(ok.status).toBe(200);
    expect(
      (await gateway.handle(request("/mcp/", { "x-thebe-token": "secret" })))
        .status
    ).toBe(200);
  });

  it("does not reveal the API, the OpenAPI document or the docs", async () => {
    for (const path of [
      "/v1/health",
      "/v1/tickets",
      "/v1/policy",
      "/v1/decisions",
      "/v1/push/quiet-hours",
      "/v1/session",
      "/openapi.json",
      "/docs",
      "/swagger",
      "/",
    ]) {
      const res = await gateway.handle(
        request(path, { Authorization: "Bearer secret" })
      );
      expect(res.status, path).toBe(404);
    }
  });
});
