import { describe, expect, it, vi } from "vitest";
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

function handler(extras: { token?: string } = {}) {
  return createThebeHttpHandler({
    version: "0.1.0",
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

  it("POST /mcp tools/call without product does not execute local tools", async () => {
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
    expect(body.error).toMatchObject({
      code: -32000,
      message: "MCP tools require the Thebe product service",
    });
  });

  it("POST /mcp tools/call container.status_summary goes through the product", async () => {
    const { createFakeRuntime } = await import("../runtime/fake-runtime.ts");
    const { createThebeApp } = await import("../product/app.ts");
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const res = await app.handler.handle(
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

  it("rejects requests when the shared token does not match", async () => {
    const app = handler({ token: "secret" });
    const res = await app.handle(
      new Request("http://127.0.0.1:8787/v1/health", {
        headers: { "X-Thebe-Token": "wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("POST /v1/messages is gone; sessions own the prompt flow", async () => {
    const res = await handler().handle(
      new Request("http://127.0.0.1:8787/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    expect(res.status).toBe(404);
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

  it("POST /v1/session then prompt/message/log/model", async () => {
    const { createFakeRuntime } = await import("../runtime/fake-runtime.ts");
    const { createThebeApp } = await import("../product/app.ts");
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "from-session" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const created = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
    );
    expect(created.status).toBe(201);
    const session = (await created.json()) as { thebeSessionId: string };
    const prompted = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello" }),
        },
      ),
    );
    expect(prompted.status).toBe(200);
    await expect(prompted.json()).resolves.toMatchObject({
      text: "from-session",
      tools: [],
      thebeSessionId: session.thebeSessionId,
    });
    const messages = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/message`,
      ),
    );
    const messageBody = (await messages.json()) as {
      messages: Array<{ role: string; text: string }>;
    };
    expect(messageBody.messages.map((row) => row.role)).toEqual([
      "user",
      "assistant",
    ]);
    const log = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/log`,
      ),
    );
    const logBody = (await log.json()) as { events: Array<{ type: string }> };
    expect(logBody.events.map((event) => event.type)).toContain("text_delta");
    const models = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/model"),
    );
    const modelBody = (await models.json()) as {
      models: Array<{ providerID: string; modelID: string }>;
    };
    expect(modelBody.models.length).toBeGreaterThan(0);
    const setModel = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/model`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: { providerID: "fake", modelID: "fake-2" },
          }),
        },
      ),
    );
    expect(setModel.status).toBe(200);
    const listed = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session"),
    );
    const listBody = (await listed.json()) as { sessions: unknown[] };
    expect(listBody.sessions).toHaveLength(1);
  });

  it("GET /v1/session/:id/log?follow=true is an event stream", async () => {
    const { createFakeRuntime } = await import("../runtime/fake-runtime.ts");
    const { createThebeApp } = await import("../product/app.ts");
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "streamed" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const created = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
    );
    const session = (await created.json()) as { thebeSessionId: string };
    await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello" }),
        },
      ),
    );
    const ac = new AbortController();
    const res = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/log?follow=true`,
        { signal: ac.signal },
      ),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = await reader.read();
    const chunk = new TextDecoder().decode(first.value);
    expect(chunk).toContain("text_delta");
    ac.abort();
  });

  it("OAuth authorize returns 202 with a URL; callback flips connected", async () => {
    const { createFakeRuntime } = await import("../runtime/fake-runtime.ts");
    const { createThebeApp } = await import("../product/app.ts");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const authorized = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/oauth/authorize", {
        method: "POST",
      }),
    );
    expect(authorized.status).toBe(202);
    const authBody = (await authorized.json()) as {
      pending?: boolean;
      url?: string;
    };
    expect(authBody.pending).toBe(true);
    expect(authBody.url).toContain("fake");
    const callback = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/oauth/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "abc", state: "s" }),
      }),
    );
    expect(callback.status).toBe(200);
    const providers = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/auth"),
    );
    const providerBody = (await providers.json()) as {
      providers: Array<{ id: string; connected: boolean }>;
    };
    expect(
      providerBody.providers.find((row) => row.id === "fake")?.connected,
    ).toBe(true);
    const again = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/oauth/authorize", {
        method: "POST",
      }),
    );
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ connected: true });
  });

  it("OAuth callback without a pending login is 404, empty input is 400", async () => {
    const { createFakeRuntime } = await import("../runtime/fake-runtime.ts");
    const { createThebeApp } = await import("../product/app.ts");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const missing = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/oauth/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "abc" }),
      }),
    );
    expect(missing.status).toBe(404);
    await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/oauth/authorize", {
        method: "POST",
      }),
    );
    const empty = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/oauth/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(empty.status).toBe(400);
  });

  it("POST prompt with an invalid mode is 400", async () => {
    const { createFakeRuntime } = await import("../runtime/fake-runtime.ts");
    const { createThebeApp } = await import("../product/app.ts");
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "unused" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const created = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
    );
    const session = (await created.json()) as { thebeSessionId: string };
    const res = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello", mode: "yell" }),
        },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("POST prompt while streaming is 409", async () => {
    const { createFakeRuntime } = await import("../runtime/fake-runtime.ts");
    const { createThebeApp } = await import("../product/app.ts");
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const created = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
    );
    const session = (await created.json()) as { thebeSessionId: string };
    const first = app.product.prompt("long", {
      thebeSessionId: session.thebeSessionId,
    });
    first.catch(() => {});
    await vi.waitFor(() => {
      expect(app.product.isStreaming(session.thebeSessionId)).toBe(true);
    });
    const second = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "again" }),
        },
      ),
    );
    expect(second.status).toBe(409);
    await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/interrupt`,
        { method: "POST" },
      ),
    );
    await expect(first).rejects.toThrow();
  });
});
