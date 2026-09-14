import { describe, expect, it, vi } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeHttpHandler } from "./handler.ts";
import {
  resetSessionLogStreamsForTests,
  sessionLogStream,
} from "./protocol/sse.ts";
import type { OpenApiDocument } from "./openapi.ts";

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

  it("serves generated OpenAPI JSON and Swagger UI", async () => {
    const spec = await handler().handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    expect(spec.status).toBe(200);
    expect(spec.headers.get("cache-control")).toBe("no-cache");
    const body = (await spec.json()) as OpenApiDocument;
    expect(body.openapi).toBe("3.0.3");
    expect(body.info.version).toBe("0.1.0");
    expect(body.paths["/v1/session/{id}/prompt"]).toBeDefined();
    expect(body.paths["/v1/session/{id}/background-task/stop-all"]).toBeDefined();
    const parserInput = body as unknown as Parameters<typeof SwaggerParser.validate>[0];
    await expect(SwaggerParser.validate(parserInput)).resolves.toBeDefined();

    const docs = await handler().handle(
      new Request("http://127.0.0.1:8787/docs"),
    );
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
    const html = await docs.text();
    expect(html).toContain("/docs/swagger-ui-bundle.js");
    expect(html).toContain("/docs/swagger-ui-init.js");
    expect(html).not.toMatch(/<script>window\.ui=/);
    expect(html).not.toContain("unpkg.com");

    const css = await handler().handle(
      new Request("http://127.0.0.1:8787/docs/swagger-ui.css"),
    );
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");

    const init = await handler().handle(
      new Request("http://127.0.0.1:8787/docs/swagger-ui-init.js"),
    );
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("text/javascript");
    expect(await init.text()).toContain("window.ui=SwaggerUIBundle");
  });

  it("GET /v1/capabilities exposes the homelab capability contract", async () => {
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities"),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const capabilities = body.capabilities as Array<Record<string, unknown>>;
    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "container.list",
          category: "containers",
          permission: "read",
          service: "arcane",
        }),
        expect.objectContaining({
          id: "list_core_events",
          category: "diagnostics",
          permission: "read",
        }),
      ]),
    );
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

  it("POST /v1/devices validates platform and token", async () => {
    const missingToken = await handler().handle(
      new Request("http://127.0.0.1:8787/v1/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "ios" }),
      }),
    );
    expect(missingToken.status).toBe(400);
    const wrongPlatform = await handler().handle(
      new Request("http://127.0.0.1:8787/v1/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "token", platform: "android" }),
      }),
    );
    expect(wrongPlatform.status).toBe(400);
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
    const inspect = (result.tools ?? []).find(
      (tool) => tool.name === "container.inspect",
    ) as { inputSchema?: { required?: string[] } } | undefined;
    const logs = (result.tools ?? []).find(
      (tool) => tool.name === "container.logs",
    ) as { inputSchema?: { required?: string[] } } | undefined;
    expect(inspect?.inputSchema?.required).toEqual(["id"]);
    expect(logs?.inputSchema?.required).toEqual(["id"]);
  });

  it("POST /mcp supports initialize and delegates core event tools", async () => {
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      version: "9.9.9",
    });
    const initialize = await app.handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );
    expect(await json(initialize)).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "thebe-core", version: "9.9.9" },
      },
    });
    const events = await app.handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_core_events", arguments: {} },
        }),
      }),
    );
    const eventBody = await json(events);
    const text = ((eventBody.result as { content?: Array<{ text?: string }> })
      .content?.[0]?.text ?? "");
    expect(JSON.parse(text)).toEqual([]);
  });

  it("POST /mcp tools/call rejects names outside the MCP allow-list", async () => {
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
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
          params: { name: "bash" },
        }),
      }),
    );
    const body = await json(res);
    expect(body.error).toMatchObject({
      code: -32000,
      message: "unknown tool: bash",
    });
  });

  it("POST /mcp tools/call without agent does not execute local tools", async () => {
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
      message: "MCP tools require the Thebe agent service",
    });
  });

  it("POST /mcp tools/call container.status_summary goes through the agent", async () => {
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
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

  it("keeps documentation readable while protecting API calls with the shared token", async () => {
    const app = handler({ token: "secret" });
    const docs = await app.handle(
      new Request("http://127.0.0.1:8787/docs"),
    );
    const spec = await app.handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const health = await app.handle(
      new Request("http://127.0.0.1:8787/v1/health"),
    );
    expect(docs.status).toBe(200);
    expect(spec.status).toBe(200);
    expect(health.status).toBe(401);
  });

  it("POST /v1/messages is a compatibility adapter delegating to prompt", async () => {
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
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
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
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
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
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
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
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
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
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
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
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
    const first = app.agent.prompt("long", { thebeSessionId: session });
    first.catch(() => {});
    await vi.waitFor(() => {
      expect(app.agent.isStreaming(session)).toBe(true);
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
    await app.agent.prompt("hi", { thebeSessionId: session });
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
    expect(html.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
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

  it("returns a workspace diff when a workspace is configured", async () => {
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      version: "0.1.0",
      workspacePath: "/tmp/thebe-http-workspace",
    });
    const created = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
    );
    const { thebeSessionId } = (await created.json()) as { thebeSessionId: string };
    const diff = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${thebeSessionId}/diff`),
    );
    expect(diff.status).toBe(200);
    await expect(diff.json()).resolves.toMatchObject({
      workspacePath: "/tmp/thebe-http-workspace",
    });
  });

  it("message list paginates with limit/after cursors", async () => {
    const { app, session } = await sessionApp([
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
    ]);
    await app.agent.prompt("one", { thebeSessionId: session });
    await app.agent.prompt("two", { thebeSessionId: session });
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
    await app.agent.prompt("hi", { thebeSessionId: session });
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

  it("permission duplicates 404 and interrupt expires the pending approval", async () => {
    const { app, session } = await sessionApp([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const pending = app.agent.prompt("run", { thebeSessionId: session });
    pending.catch(() => {});
    await vi.waitFor(() => {
      expect(app.agent.pendingPermissionIds().length).toBe(1);
    });
    const permissionId = app.agent.pendingPermissionIds()[0]!;
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
    expect(resolve.status).toBe(404);
    await Promise.allSettled([pending]);
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
    const pending = app.agent.prompt("run", { thebeSessionId: session });
    pending.catch(() => {});
    await vi.waitFor(() => {
      expect(app.agent.pendingPermissionIds().length).toBe(1);
    });
    const events = app.agent.events(session);
    const requested = events.find(
      (event) => event.type === "permission_requested",
    );
    expect(requested).toMatchObject({ toolName: "bash", risk: "high" });
    expect(requested?.type === "permission_requested" && requested.argsSummary).toContain("ls");
    expect(JSON.stringify(events)).not.toContain("sk-live-secret-value");
    await app.agent.resolvePermission(session, app.agent.pendingPermissionIds()[0]!, {
      response: "deny",
    });
    await pending;
  });

  it("session status reports awaiting_permission while blocked", async () => {
    const { app, session } = await sessionApp([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const pending = app.agent.prompt("run", { thebeSessionId: session });
    pending.catch(() => {});
    await vi.waitFor(() => {
      expect(app.agent.pendingPermissionIds().length).toBe(1);
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
    await app.agent.resolvePermission(session, app.agent.pendingPermissionIds()[0]!, {
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
      failed.app.agent.prompt("x", { thebeSessionId: failed.session }),
    ).rejects.toThrow("boom");
    const log = failed.app.agent.events(failed.session);
    expect(log.some((event) => event.type === "error")).toBe(true);
    expect(log.some((event) => event.type === "interrupted")).toBe(false);
    const aborted = await sessionApp([{ kind: "hang" }]);
    const hanging = aborted.app.agent.prompt("x", {
      thebeSessionId: aborted.session,
    });
    hanging.catch(() => {});
    await vi.waitFor(() => {
      expect(aborted.app.agent.isStreaming(aborted.session)).toBe(true);
    });
    await aborted.app.agent.interrupt(aborted.session);
    await expect(hanging).rejects.toThrow();
    const abortedLog = aborted.app.agent.events(aborted.session);
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
    const result = await app.agent.prompt(
      {
        text: "read this",
        files: [{ mediaType: "text/plain", data: content, filename: "app.log" }],
      },
      { thebeSessionId: session },
    );
    expect(result.text).toBe("done");
    expect(app.agent.messages()[0]?.text).toContain("error: disk full");
  });

  it("POST prompt with an invalid mode is 400", async () => {
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
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
    const { createFakeRuntime } = await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
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
    const first = app.agent.prompt("long", {
      thebeSessionId: session.thebeSessionId,
    });
    first.catch(() => {});
    await vi.waitFor(() => {
      expect(app.agent.isStreaming(session.thebeSessionId)).toBe(true);
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

  it("permission response must be allow or deny", async () => {
    const { app, session } = await sessionApp([{ kind: "text", text: "x" }]);
    const invalid = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/permission/perm_x`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: "yes" }),
        },
      ),
    );
    expect(invalid.status).toBe(400);
    const missing = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session}/permission/perm_x`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );
    expect(missing.status).toBe(400);
  });

  it("closes idle follow log streams and caps concurrent streams", async () => {
    resetSessionLogStreamsForTests({ max: 2 });
    try {
      const { app, session } = await sessionApp([{ kind: "text", text: "x" }]);
      const idleAc = new AbortController();
      const idle = sessionLogStream(
        app.agent,
        session,
        new Request("http://127.0.0.1:8787/log", { signal: idleAc.signal }),
        0,
        { idleMs: 30 },
      );
      const idleReader = idle.body!.getReader();
      const idleDone = idleReader.read();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await idleDone).done).toBe(true);

      const firstAc = new AbortController();
      const secondAc = new AbortController();
      const first = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${session}/log?follow=true`,
          { signal: firstAc.signal },
        ),
      );
      const second = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${session}/log?follow=true`,
          { signal: secondAc.signal },
        ),
      );
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const third = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${session}/log?follow=true`,
        ),
      );
      expect(third.status).toBe(429);
      firstAc.abort();
      secondAc.abort();
      await first.body?.cancel();
      await second.body?.cancel();
    } finally {
      resetSessionLogStreamsForTests();
    }
  });
});
