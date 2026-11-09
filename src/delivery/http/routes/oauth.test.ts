import { describe, expect, it } from "vitest";
import { createThebeHttpHandler } from "../handler.ts";
import type { OAuthHttpIntegration } from "../oauth/service.ts";
import type { TokenCaller } from "../token-store.ts";

function pairingHandler(options: {
  verify(received: string): TokenCaller | undefined;
  issuePairingCode?: OAuthHttpIntegration["issuePairingCode"];
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
    resource: "https://home.example/mcp",
  };
  return createThebeHttpHandler({
    version: "t",
    token: { verify: options.verify },
    oauth,
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
});
