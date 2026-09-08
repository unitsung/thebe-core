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

  it("POST /v1/messages is a compatibility adapter delegating to prompt", async () => {
    const { createFakeRuntime } = await import("../runtime/fake-runtime.ts");
    const { createThebeApp } = await import("../product/app.ts");
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "messages response" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; text: string };
    expect(data.ok).toBe(true);
    expect(data.text).toBe("messages response");
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
      models: Array<{ providerId: string; modelId: string }>;
    };
    expect(modelBody.models.length).toBeGreaterThan(0);
    const setModel = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/model`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: { providerId: "fake", modelId: "fake-2" },
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
      providers: Array<{ id: string; authStatus: string }>;
    };
    expect(
      providerBody.providers.find((row) => row.id === "fake")?.authStatus,
    ).toBe("connected");
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

  async function sessionApp(turns: Array<{ kind: "text"; text: string } | { kind: "tools"; calls: Array<{ name: string; args?: unknown }> } | { kind: "hang" } | { kind: "error"; message: string }>) {
    const { createFakeRuntime } = await import("../runtime/fake-runtime.ts");
    const { createThebeApp } = await import("../product/app.ts");
    const fake = createFakeRuntime();
    fake.queueTurns(turns);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const created = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
    );
    const session = (await created.json()) as { thebeSessionId: string };
    return { app, session: session.thebeSessionId };
  }

  it("POST /v1/session accepts title and an initial model", async () => {
    const { app } = await sessionApp([{ kind: "text", text: "x" }]);
    const created = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "ops review",
          model: { providerId: "fake", modelId: "fake-2" },
        }),
      }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      title?: string;
      createdAt?: string;
      updatedAt?: string;
    };
    expect(body.title).toBe("ops review");
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
    const badModel = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: { providerId: "fake", modelId: "nope" },
        }),
      }),
    );
    expect(badModel.status).toBe(404);
  });

  it("thinking level route validates and switches", async () => {
    const { app, session } = await sessionApp([{ kind: "text", text: "x" }]);
    const bad = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/thinking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: "ultra" }),
      }),
    );
    expect(bad.status).toBe(400);
    const ok = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/thinking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: "high" }),
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("model switch while streaming is 409, unknown model is 404", async () => {
    const { app, session } = await sessionApp([{ kind: "hang" }]);
    const first = app.product.prompt("long", { thebeSessionId: session });
    first.catch(() => {});
    await vi.waitFor(() => {
      expect(app.product.isStreaming(session)).toBe(true);
    });
    const busy = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: { providerId: "fake", modelId: "fake-1" },
        }),
      }),
    );
    expect(busy.status).toBe(409);
    const thinking = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/thinking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: "low" }),
      }),
    );
    expect(thinking.status).toBe(409);
    await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/interrupt`, {
        method: "POST",
      }),
    );
    await expect(first).rejects.toThrow();
    const unknown = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: { providerId: "fake", modelId: "nope" },
        }),
      }),
    );
    expect(unknown.status).toBe(404);
  });

  it("GET /v1/model supports provider filter and normalized DTOs", async () => {
    const { app } = await sessionApp([{ kind: "text", text: "x" }]);
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/model?provider=fake&all=true"),
    );
    const body = (await res.json()) as {
      models: Array<Record<string, unknown>>;
    };
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models[0]).toMatchObject({
      providerId: "fake",
      displayName: "Fake One",
      available: true,
    });
    const empty = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/model?provider=other"),
    );
    await expect(empty.json()).resolves.toMatchObject({ models: [] });
  });

  it("DELETE /v1/auth/:id logs out", async () => {
    const { app } = await sessionApp([{ kind: "text", text: "x" }]);
    await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/oauth/authorize", {
        method: "POST",
      }),
    );
    await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/oauth/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "abc" }),
      }),
    );
    const out = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/auth/fake", { method: "DELETE" }),
    );
    expect(out.status).toBe(200);
    const providers = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/auth"),
    );
    const body = (await providers.json()) as {
      providers: Array<{ id: string; authStatus: string }>;
    };
    expect(
      body.providers.find((row) => row.id === "fake")?.authStatus,
    ).toBe("missing");
  });

  it("export format and diff code", async () => {
    const { app, session } = await sessionApp([{ kind: "text", text: "hi" }]);
    await app.product.prompt("hi", { thebeSessionId: session });
    const jsonl = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/export?format=jsonl`,
      ),
    );
    expect(jsonl.headers.get("content-type")).toContain("x-ndjson");
    const html = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/export?format=html`,
      ),
    );
    expect(html.headers.get("content-type")).toContain("text/html");
    const bad = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/export?format=pdf`,
      ),
    );
    expect(bad.status).toBe(400);
    const diff = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/diff`),
    );
    expect(diff.status).toBe(501);
    await expect(diff.json()).resolves.toMatchObject({
      code: "feature_not_implemented",
    });
  });

  it("message list paginates with limit/after cursors", async () => {
    const { app, session } = await sessionApp([
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
    ]);
    await app.product.prompt("one", { thebeSessionId: session });
    await app.product.prompt("two", { thebeSessionId: session });
    const page = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/message?limit=2`,
      ),
    );
    const pageBody = (await page.json()) as {
      messages: Array<{ id: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(pageBody.messages).toHaveLength(2);
    expect(pageBody.total).toBe(4);
    expect(pageBody.hasMore).toBe(true);
    const rest = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/message?after=${pageBody.messages[1]!.id}`,
      ),
    );
    const restBody = (await rest.json()) as {
      messages: unknown[];
      hasMore: boolean;
    };
    expect(restBody.messages).toHaveLength(2);
    expect(restBody.hasMore).toBe(false);
    const badCursor = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/message?after=nope`,
      ),
    );
    expect(badCursor.status).toBe(400);
    const badLimit = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/message?limit=zero`,
      ),
    );
    expect(badLimit.status).toBe(400);
  });

  it("log cursor paginates and follow replays with ids", async () => {
    const { app, session } = await sessionApp([{ kind: "text", text: "hi" }]);
    await app.product.prompt("hi", { thebeSessionId: session });
    const first = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/log`),
    );
    const firstBody = (await first.json()) as {
      events: Array<{ type: string }>;
      next: number;
    };
    expect(firstBody.events.length).toBeGreaterThan(0);
    expect(firstBody.next).toBe(firstBody.events.length);
    const second = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/log?after=${firstBody.next}`,
      ),
    );
    await expect(second.json()).resolves.toMatchObject({ events: [] });
    const bad = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/log?after=-1`),
    );
    expect(bad.status).toBe(400);
    const ac = new AbortController();
    const follow = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/log?follow=true&after=0`,
        { signal: ac.signal },
      ),
    );
    const reader = follow.body!.getReader();
    let text = "";
    for (let i = 0; i < 10 && !text.includes("session_end"); i++) {
      const chunk = await reader.read();
      text += new TextDecoder().decode(chunk.value);
      if (chunk.done) {
        break;
      }
    }
    ac.abort();
    expect(text).toContain("turn_end");
    expect(text).toContain("session_end");
    expect(text).toContain("id: ");
  });

  it("permission duplicates 404 and resolve-after-interrupt stays 200", async () => {
    const { app, session } = await sessionApp([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const pending = app.product.prompt("run", { thebeSessionId: session });
    pending.catch(() => {});
    await vi.waitFor(() => {
      expect(app.product.pendingPermissionIds().length).toBe(1);
    });
    const permissionId = app.product.pendingPermissionIds()[0]!;
    await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/interrupt`, {
        method: "POST",
      }),
    );
    const resolve = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/permission/${permissionId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: "deny" }),
        },
      ),
    );
    expect(resolve.status).toBe(200);
    await pending;
    const again = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/permission/${permissionId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: "deny" }),
        },
      ),
    );
    expect(again.status).toBe(404);
  });

  it("permission events carry a redacted args summary and risk", async () => {
    const { app, session } = await sessionApp([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls", token: "sk-live-secret-value" } }] },
      { kind: "text", text: "after" },
    ]);
    const pending = app.product.prompt("run", { thebeSessionId: session });
    pending.catch(() => {});
    await vi.waitFor(() => {
      expect(app.product.pendingPermissionIds().length).toBe(1);
    });
    const events = app.product.events(session);
    const requested = events.find(
      (event) => event.type === "permission_requested",
    );
    expect(requested).toMatchObject({ toolName: "bash", risk: "high" });
    expect(requested?.type === "permission_requested" && requested.argsSummary).toContain("ls");
    expect(JSON.stringify(events)).not.toContain("sk-live-secret-value");
    await app.product.resolvePermission(session, app.product.pendingPermissionIds()[0]!, {
      response: "deny",
    });
    await pending;
  });

  it("session status reports awaiting_permission while blocked", async () => {
    const { app, session } = await sessionApp([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const pending = app.product.prompt("run", { thebeSessionId: session });
    pending.catch(() => {});
    await vi.waitFor(() => {
      expect(app.product.pendingPermissionIds().length).toBe(1);
    });
    const status = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session/status"),
    );
    const body = (await status.json()) as {
      sessions: Array<{ thebeSessionId: string; status: string }>;
    };
    expect(
      body.sessions.find((row) => row.thebeSessionId === session)?.status,
    ).toBe("awaiting_permission");
    await app.product.resolvePermission(session, app.product.pendingPermissionIds()[0]!, {
      response: "deny",
    });
    await pending;
    const idle = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session/status"),
    );
    const idleBody = (await idle.json()) as {
      sessions: Array<{ thebeSessionId: string; status: string }>;
    };
    expect(
      idleBody.sessions.find((row) => row.thebeSessionId === session)?.status,
    ).toBe("idle");
  });

  it("failed runs log an error event, aborts log interrupted only", async () => {
    const failed = await sessionApp([{ kind: "error", message: "boom" }]);
    await expect(
      failed.app.product.prompt("x", { thebeSessionId: failed.session }),
    ).rejects.toThrow("boom");
    const log = failed.app.product.events(failed.session);
    expect(log.some((event) => event.type === "error")).toBe(true);
    expect(log.some((event) => event.type === "interrupted")).toBe(false);
    const aborted = await sessionApp([{ kind: "hang" }]);
    const hanging = aborted.app.product.prompt("x", {
      thebeSessionId: aborted.session,
    });
    hanging.catch(() => {});
    await vi.waitFor(() => {
      expect(aborted.app.product.isStreaming(aborted.session)).toBe(true);
    });
    await aborted.app.product.interrupt(aborted.session);
    await expect(hanging).rejects.toThrow();
    const abortedLog = aborted.app.product.events(aborted.session);
    expect(
      abortedLog.some((event) => event.type === "interrupted"),
    ).toBe(true);
    expect(abortedLog.some((event) => event.type === "error")).toBe(false);
  });

  it("prompt file validation rejects bad input with 4xx", async () => {
    const { app, session } = await sessionApp([{ kind: "text", text: "x" }]);
    const badType = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "look",
          files: [{ mediaType: "application/pdf", data: "aaaa" }],
        }),
      }),
    );
    expect(badType.status).toBe(400);
    const tooBig = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "look",
          files: [{ mediaType: "image/png", data: "a".repeat(3_000_000) }],
        }),
      }),
    );
    expect(tooBig.status).toBe(413);
  });

  it("text files enter the runtime as content", async () => {
    const { app, session } = await sessionApp([{ kind: "text", text: "done" }]);
    const content = Buffer.from("error: disk full").toString("base64");
    const result = await app.product.prompt(
      {
        text: "read this",
        files: [{ mediaType: "text/plain", data: content, filename: "app.log" }],
      },
      { thebeSessionId: session },
    );
    expect(result.text).toBe("done");
    expect(app.product.messages()[0]?.text).toContain("error: disk full");
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
