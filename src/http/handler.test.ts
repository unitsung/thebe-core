import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../providers/index.ts";
import { createThebeHttpHandler } from "./handler.ts";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [
      {
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        status: "Up",
        created: 1,
      },
    ],
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 4,
      runningContainers: 2,
      pausedContainers: 0,
      exitedContainers: 2,
      lastUpdated: 1,
    }),
  };
}

function handler(
  extras: {
    token?: string;
    ask?: (text: string) => Promise<{ text: string; tools: string[] }>;
  } = {},
) {
  return createThebeHttpHandler({
    version: "0.1.0",
    provider: provider(),
    ...extras,
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("Thebe HTTP handler (iOS ThebeCoreClient)", () => {
  it("GET /v1/health returns ok and version", async () => {
    const res = await handler().handle(
      new Request("http://127.0.0.1:8787/v1/health"),
    );
    expect(res.status).toBe(200);
    await expect(json(res)).resolves.toEqual({ ok: true, version: "0.1.0" });
  });

  it("GET /v1/events returns an events array", async () => {
    const res = await handler().handle(
      new Request("http://127.0.0.1:8787/v1/events"),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("POST /v1/devices accepts an iOS token", async () => {
    const res = await handler().handle(
      new Request("http://127.0.0.1:8787/v1/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "apns-token", platform: "ios" }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it("POST /mcp tools/list includes the four container tools", async () => {
    const res = await handler().handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const result = body.result as { tools?: Array<{ name?: string }> };
    const names = (result.tools ?? []).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "container.list",
        "container.inspect",
        "container.logs",
        "container.status_summary",
        "list_core_events",
        "diagnose_from_events",
      ]),
    );
  });

  it("POST /mcp tools/call container.status_summary returns provider counts", async () => {
    const res = await handler().handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "container.status_summary" },
        }),
      }),
    );
    const body = await json(res);
    const result = body.result as { content?: Array<{ text?: string }> };
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("runningContainers");
    expect(text).toContain("2");
    expect(body.error).toBeUndefined();
  });

  it("POST /v1/ask returns the Ask reply and tools", async () => {
    const res = await handler({
      ask: async (text) => ({
        text: `pong:${text}`,
        tools: ["container.status_summary"],
      }),
    }).handle(
      new Request("http://127.0.0.1:8787/v1/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "how many running?" }),
      }),
    );
    expect(res.status).toBe(200);
    await expect(json(res)).resolves.toEqual({
      text: "pong:how many running?",
      tools: ["container.status_summary"],
    });
  });

  it("rejects requests when the shared token does not match", async () => {
    const app = handler({ token: "secret" });
    const res = await app.handle(
      new Request("http://127.0.0.1:8787/v1/health", {
        headers: { "X-Thebe-Token": "wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("POST /v1/ask through createThebeApp uses the product ask mapping", async () => {
    const { createFakeRuntime } = await import("../runtime/fake-runtime.ts");
    const { createThebeApp } = await import("../product/app.ts");
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "from-product" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      text: "from-product",
      tools: [],
    });
  });

  it("accepts the matching X-Thebe-Token", async () => {
    const app = handler({ token: "secret" });
    const res = await app.handle(
      new Request("http://127.0.0.1:8787/v1/health", {
        headers: { "X-Thebe-Token": "secret" },
      }),
    );
    expect(res.status).toBe(200);
  });
});
