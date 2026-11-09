import { describe, expect, it } from "vitest";
import { createThebeHttpHandler } from "./handler.ts";
import { createMcpOnlyHandler } from "./mcp-only.ts";
import type { OAuthHttpIntegration } from "./oauth/service.ts";

const gateway = createMcpOnlyHandler(
  createThebeHttpHandler({ version: "t", token: "secret" })
);
const request = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:8788${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
const metadataPath = "/.well-known/oauth-protected-resource/mcp";
const oauth: OAuthHttpIntegration = {
  verify: async () => undefined,
  isPublicPath: (path) => path === metadataPath,
  publicResponse: (request) =>
    new URL(request.url).pathname === metadataPath
      ? Response.json({ resource: "https://home.example/mcp" })
      : undefined,
  issuePairingCode: () => ({
    code: "ABCDE-23456",
    expiresAt: "2026-11-09T10:05:00.000Z",
  }),
  resource: "https://home.example/mcp",
};
const oauthGateway = createMcpOnlyHandler(
  createThebeHttpHandler({
    version: "t",
    token: "secret",
    oauth,
  })
);

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

  it("publishes OAuth resource metadata but keeps pairing behind the app API", async () => {
    const metadata = await oauthGateway.handle(
      new Request(`http://127.0.0.1:8788${metadataPath}`)
    );
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toEqual({
      resource: "https://home.example/mcp",
    });

    const pairing = await oauthGateway.handle(
      request("/v1/oauth/pairing-code", {
        Authorization: "Bearer secret",
      })
    );
    expect(pairing.status).toBe(404);
  });
});
