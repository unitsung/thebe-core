import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createThebeHttpHandler } from "./handler.ts";
import {
  createDeviceToken,
  createTokenVerifier,
  describeTokenScopes,
  tokenMayDeleteIrreversibly,
  tokenMayWrite,
} from "./token-store.ts";

const reader = "r".repeat(64);
const writer = "w".repeat(64);
const full = "f".repeat(64);

async function handler() {
  const configDir = await mkdtemp(join(tmpdir(), "thebe-scope-"));
  createDeviceToken({
    configDir,
    name: "Reader",
    scope: "mcp:read",
    generate: () => reader,
  });
  createDeviceToken({
    configDir,
    name: "Writer",
    scope: "mcp:write",
    generate: () => writer,
  });
  createDeviceToken({ configDir, name: "iPad", generate: () => full });
  return createThebeHttpHandler({
    version: "t",
    token: createTokenVerifier({ configDir, env: {} }),
  });
}

const call = (token: string, path: string, init: RequestInit = {}) =>
  new Request(`http://127.0.0.1:8787${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
const ping = {
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
};

describe("a token limited to /mcp", () => {
  it("works on /mcp", async () => {
    const h = await handler();
    for (const token of [reader, writer]) {
      const res = await h.handle(call(token, "/mcp", ping));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ result: {} });
    }
  });

  it("works on /mcp/ with a trailing slash, as the router treats it", async () => {
    const h = await handler();
    const res = await h.handle(call(reader, "/mcp/", ping));
    expect(res.status).toBe(200);
  });

  it("is refused everywhere else, so a read token cannot start a session or run an action", async () => {
    const h = await handler();
    const attempts: Array<[string, RequestInit]> = [
      ["/v1/health", {}],
      ["/v1/tickets", {}],
      ["/v1/session", { method: "POST", body: "{}" }],
      ["/v1/action", { method: "POST", body: "{}" }],
      ["/v1/settings/permissions", { method: "PATCH", body: "{}" }],
    ];
    for (const token of [reader, writer]) {
      for (const [path, init] of attempts) {
        const res = await h.handle(call(token, path, init));
        expect(res.status, `${path} with ${token.slice(0, 1)}`).toBe(403);
        expect(await res.json()).toMatchObject({
          ok: false,
          code: "token_scope",
        });
      }
    }
  });

  it("does not limit a token that was made without a scope", async () => {
    const h = await handler();
    expect((await h.handle(call(full, "/v1/health"))).status).toBe(200);
    expect((await h.handle(call(full, "/mcp", ping))).status).toBe(200);
  });

  it("still answers 401 for an unknown token before it says anything about scopes", async () => {
    const h = await handler();
    expect((await h.handle(call("nope", "/v1/health"))).status).toBe(401);
  });
});

describe("scope levels", () => {
  it("each scope includes the ones below it, and a full token needs none", async () => {
    const { mkdtemp: make } = await import("node:fs/promises");
    const configDir = await make(join(tmpdir(), "thebe-levels-"));
    for (const scope of [
      "mcp:read",
      "mcp:write",
      "mcp:irreversible",
    ] as const) {
      createDeviceToken({
        configDir,
        name: scope.replace(":", "-"),
        scope,
        generate: () => scope.padEnd(64, "x"),
      });
    }
    const verifier = createTokenVerifier({ configDir, env: {} });
    const caller = (scope: string) => {
      const found = verifier.verify(scope.padEnd(64, "x"));
      expect(found, scope).toBeDefined();
      return found;
    };
    expect(tokenMayWrite(caller("mcp:read"))).toBe(false);
    expect(tokenMayWrite(caller("mcp:write"))).toBe(true);
    expect(tokenMayDeleteIrreversibly(caller("mcp:write"))).toBe(false);
    expect(tokenMayWrite(caller("mcp:irreversible"))).toBe(true);
    expect(tokenMayDeleteIrreversibly(caller("mcp:irreversible"))).toBe(true);
    expect(tokenMayDeleteIrreversibly({ name: "iPad" })).toBe(true);
    expect(describeTokenScopes(caller("mcp:irreversible")?.scopes)).toBe(
      "mcp:irreversible"
    );
  });
});

describe("rate limit on a scoped token", () => {
  it("refuses at once past the limit with 429, and leaves full-access tokens alone", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-rate-"));
    createDeviceToken({
      configDir,
      name: "Reader",
      scope: "mcp:read",
      generate: () => reader,
    });
    createDeviceToken({ configDir, name: "iPad", generate: () => full });
    const h = createThebeHttpHandler({
      version: "t",
      token: createTokenVerifier({ configDir, env: {} }),
      mcpRateLimit: 2,
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await h.handle(call(reader, "/mcp", ping))).status);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
    const limited = await h.handle(call(reader, "/mcp", ping));
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    for (let i = 0; i < 5; i++) {
      expect((await h.handle(call(full, "/mcp", ping))).status).toBe(200);
    }
  });
});
