import { describe, expect, it } from "vitest";
import { createThebeHttpHandler } from "../handler.ts";
import type { OAuthHttpIntegration } from "../oauth/service.ts";
import type { TokenCaller } from "../token-store.ts";

function pairingHandler(options: {
  verify(received: string): TokenCaller | undefined;
  issuePairingCode?: OAuthHttpIntegration["issuePairingCode"];
  listConnections?: OAuthHttpIntegration["listConnections"];
  revokeConnection?: OAuthHttpIntegration["revokeConnection"];
}) {
  const oauth: OAuthHttpIntegration = {
    verify: async () => undefined,
    isPublicPath: () => false,
    publicResponse: () => undefined,
    issuePairingCode:
      options.issuePairingCode ??
      (() => ({
        code: "ABCDE-23456",
        expiresAt: "2026-11-09T10:05:00.000Z",
      })),
    listConnections: options.listConnections ?? (async () => []),
    revokeConnection: options.revokeConnection ?? (async () => false),
    resource: "https://home.example/mcp",
  };
  return createThebeHttpHandler({
    version: "t",
    token: { verify: options.verify },
    oauth,
  });
}

function connectionRequest(
  method: "GET" | "DELETE" | "POST",
  suffix = "",
  token?: string
): Request {
  return new Request(`http://127.0.0.1:8787/v1/oauth/connections${suffix}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function request(method: "GET" | "POST", token?: string): Request {
  return new Request("http://127.0.0.1:8787/v1/oauth/pairing-code", {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("OAuth pairing route", () => {
  it("requires a full-access token and returns a short-lived code", async () => {
    let issued = 0;
    const handler = pairingHandler({
      verify(received) {
        if (received === "full") return { name: "Thebe App" };
        if (received === "scoped") {
          return { name: "External agent", scopes: ["mcp:read"] };
        }
        return undefined;
      },
      issuePairingCode() {
        issued += 1;
        return {
          code: "ABCDE-23456",
          expiresAt: "2026-11-09T10:05:00.000Z",
        };
      },
    });

    expect((await handler.handle(request("POST"))).status).toBe(401);
    expect((await handler.handle(request("POST", "scoped"))).status).toBe(403);
    expect(issued).toBe(0);

    const response = await handler.handle(request("POST", "full"));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      code: "ABCDE-23456",
      expiresAt: "2026-11-09T10:05:00.000Z",
    });
    expect(issued).toBe(1);
  });

  it("allows only POST and does not consume a code on GET", async () => {
    let issued = 0;
    const handler = pairingHandler({
      verify: (received) =>
        received === "full" ? { name: "Thebe App" } : undefined,
      issuePairingCode() {
        issued += 1;
        return {
          code: "ABCDE-23456",
          expiresAt: "2026-11-09T10:05:00.000Z",
        };
      },
    });
    const response = await handler.handle(request("GET", "full"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(issued).toBe(0);
  });

  it("lists and revokes connector grants with a full-access token", async () => {
    const revoked: string[] = [];
    const handler = pairingHandler({
      verify: (received) =>
        received === "full"
          ? { name: "Thebe App" }
          : received === "scoped"
            ? { name: "External agent", scopes: ["mcp:read"] }
            : undefined,
      listConnections: async () => [
        {
          id: "grant-1",
          clientId: "test-client",
          clientName: "Test client",
          scopes: ["mcp:read", "offline_access"],
          createdAt: "2026-11-10T06:00:00.000Z",
          expiresAt: "2026-12-10T06:00:00.000Z",
          refreshToken: true,
        },
      ],
      revokeConnection: async (grantId) => {
        revoked.push(grantId);
        return grantId === "grant-1";
      },
    });

    const listed = await handler.handle(connectionRequest("GET", "", "full"));
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    await expect(listed.json()).resolves.toMatchObject({
      connections: [
        {
          id: "grant-1",
          clientName: "Test client",
          scopes: ["mcp:read", "offline_access"],
        },
      ],
    });
    expect(
      (await handler.handle(connectionRequest("GET", "", "scoped"))).status
    ).toBe(403);
    expect(
      (await handler.handle(connectionRequest("DELETE", "/grant-1", "scoped")))
        .status
    ).toBe(403);
    expect(revoked).toEqual([]);

    const wrongListMethod = await handler.handle(
      connectionRequest("POST", "", "full")
    );
    expect(wrongListMethod.status).toBe(405);
    expect(wrongListMethod.headers.get("allow")).toBe("GET");
    const wrongDeleteMethod = await handler.handle(
      connectionRequest("GET", "/grant-1", "full")
    );
    expect(wrongDeleteMethod.status).toBe(405);
    expect(wrongDeleteMethod.headers.get("allow")).toBe("DELETE");

    const deleted = await handler.handle(
      connectionRequest("DELETE", "/grant-1", "full")
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({
      ok: true,
      id: "grant-1",
    });
    expect(revoked).toEqual(["grant-1"]);
    expect(
      (await handler.handle(connectionRequest("DELETE", "/missing", "full")))
        .status
    ).toBe(404);
  });
});
