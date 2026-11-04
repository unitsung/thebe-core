import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { listenThebeHttp } from "./listen.ts";
import { createDeviceToken, createTokenVerifier } from "./token-store.ts";

const provider: ContainerInfoProvider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => "ok",
  getStatusSummary: async () => ({
    totalContainers: 0,
    runningContainers: 0,
    pausedContainers: 0,
    exitedContainers: 0,
    lastUpdated: 1,
  }),
  restartContainer: async () => {},
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

/** Core with its main port and the /mcp-only port both listening, as `serve.ts` starts it. */
async function startBoth(rateLimit?: { limit: number; windowMs: number }) {
  const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-listener-"));
  const tokens = {
    alpha: "a".repeat(64),
    beta: "b".repeat(64),
  };
  createDeviceToken({ configDir, name: "alpha", generate: () => tokens.alpha });
  createDeviceToken({ configDir, name: "beta", generate: () => tokens.beta });
  let nowMs = Date.parse("2026-11-04T10:00:00Z");
  const app = createThebeApp({
    runtime: createFakeRuntime().runtime,
    provider,
    token: createTokenVerifier({ configDir, env: {} }),
    now: () => new Date(nowMs),
  });
  const main = await listenThebeHttp(app.handler, { port: 0 });
  const mcp = await listenThebeHttp(app.createMcpHandler({ rateLimit }), {
    port: 0,
  });
  servers.push(main.server, mcp.server);
  return {
    main: main.url,
    mcp: mcp.url,
    tokens,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const ping = (url: string, token?: string) =>
  fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });

describe("the /mcp-only listener", () => {
  it("serves /mcp with a valid token and nothing else", async () => {
    const { mcp, tokens } = await startBoth();

    const ok = await ping(mcp, tokens.alpha);
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ jsonrpc: "2.0", id: 1 });

    for (const path of [
      "/v1/health",
      "/v1/activity",
      "/v1/audit",
      "/docs",
      "/docs/",
      "/swagger",
      "/openapi.json",
      "/",
    ]) {
      const res = await fetch(`${mcp}${path}`, {
        headers: { Authorization: `Bearer ${tokens.alpha}` },
      });
      expect(res.status, path).toBe(404);
    }
    const posted = await fetch(`${mcp}/v1/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.alpha}` },
      body: "{}",
    });
    expect(posted.status).toBe(404);
  });

  it("leaves the main port as it was", async () => {
    const { main, tokens } = await startBoth();
    const headers = { Authorization: `Bearer ${tokens.alpha}` };
    expect((await fetch(`${main}/v1/health`, { headers })).status).toBe(200);
    expect((await fetch(`${main}/docs`)).status).toBe(200);
    expect((await fetch(`${main}/openapi.json`)).status).toBe(200);
    expect((await ping(main, tokens.alpha)).status).toBe(200);
  });

  it("still checks the token", async () => {
    const { mcp } = await startBoth();
    expect((await ping(mcp)).status).toBe(401);
    expect((await ping(mcp, "nope")).status).toBe(401);
  });

  it("still checks the Host header", async () => {
    const { tokens } = await startBoth();
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider,
      token: tokens.alpha,
      allowedHosts: ["127.0.0.1"],
    });
    const handler = app.createMcpHandler();
    const call = (host: string) =>
      handler.handle(
        new Request("http://127.0.0.1:8787/mcp", {
          method: "POST",
          headers: { host, Authorization: `Bearer ${tokens.alpha}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        })
      );
    expect((await call("127.0.0.1:8788")).status).toBe(200);
    expect((await call("evil.example.com")).status).toBe(403);
  });
});

describe("per-token rate limits on the /mcp-only listener", () => {
  it("answers a token over its limit at once and leaves other tokens alone", async () => {
    const { mcp, tokens, advance } = await startBoth({
      limit: 2,
      windowMs: 60_000,
    });
    expect((await ping(mcp, tokens.alpha)).status).toBe(200);
    expect((await ping(mcp, tokens.alpha)).status).toBe(200);

    const limited = await ping(mcp, tokens.alpha);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const body = (await limited.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, code: "rate_limited" });
    expect(String(body.error)).toMatch(
      /alpha.*2 requests per 60 seconds.*60 seconds/
    );

    expect((await ping(mcp, tokens.beta)).status).toBe(200);

    advance(59_000);
    const stillLimited = await ping(mcp, tokens.alpha);
    expect(stillLimited.status).toBe(429);
    expect(stillLimited.headers.get("retry-after")).toBe("1");

    advance(1_000);
    expect((await ping(mcp, tokens.alpha)).status).toBe(200);
  });

  it("does not count requests that fail the token check", async () => {
    const { mcp, tokens } = await startBoth({ limit: 1, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      expect((await ping(mcp, "nope")).status).toBe(401);
    }
    expect((await ping(mcp, tokens.alpha)).status).toBe(200);
  });

  it("does not limit the main port", async () => {
    const { main, tokens } = await startBoth({ limit: 1, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      expect((await ping(main, tokens.alpha)).status).toBe(200);
    }
  });
});
