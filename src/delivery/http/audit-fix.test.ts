import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../../agent/security/audit/audit-log.ts";
import { createThebeApp } from "../../app/create.ts";
import { createPolicyEngine } from "../../agent/security/policy/policy-engine.ts";
import { createThebeAgent } from "../../agent/index.ts";
import { assertValidSessionId, createAgentStore } from "../../agent/store.ts";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createContainerTools } from "../../agent/tools/container-tools.ts";
import { wrapCustomTools } from "../../agent/tools/wrapped-tool.ts";
import { hashParameters } from "../../agent/security/audit/audit-log.ts";
import { resolveAllowedHosts } from "./bind.ts";
import { drainThebeHttpServer } from "./drain.ts";
import { createThebeHttpHandler } from "./handler.ts";
import { listenThebeHttp, MAX_HTTP_BODY_BYTES } from "./listen.ts";

function mockProvider(): ContainerInfoProvider {
  return {
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
  };
}

describe("audit remediation", () => {
  it("canonicalJson does not recurse on circular objects", () => {
    const loop: { self?: unknown } = {};
    loop.self = loop;
    expect(canonicalJson(loop)).toContain("[Circular]");
  });

  it("rejects path-traversal session ids", () => {
    expect(() => assertValidSessionId("../etc/passwd")).toThrow(/invalid session id/);
    expect(() => assertValidSessionId("ok-id_1")).not.toThrow();
  });

  it("AgentStore refuses traversal ids", async () => {
    const store = createAgentStore("/tmp/thebe-store-test");
    await expect(
      store.save({
        thebeSessionId: "../escape",
        runtimeId: "pi-coding-agent",
        runtimeSessionId: "r1",
      }),
    ).rejects.toThrow(/invalid session id/);
  });

  it("rejects oversize HTTP bodies with 413", async () => {
    const app = createThebeHttpHandler({ version: "0.1.0" });
    const { server, url } = await listenThebeHttp(app, {
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const res = await fetch(`${url}/v1/devices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(MAX_HTTP_BODY_BYTES + 64),
      });
      expect(res.status).toBe(413);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("JSON /v1/messages auto-denies permissions instead of deadlocking", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "done" },
    ]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    const session = await app.agent.createSession();
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "run",
          sessionId: session.thebeSessionId,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; text: string };
    expect(body.ok).toBe(true);
    expect(body.text).toBe("done");
    expect(app.agent.pendingPermissionIds()).toHaveLength(0);
  });

  it("SSE /v1/messages closes after session_end, not turn_end", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "hello" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    const session = await app.agent.createSession();
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          text: "hi",
          sessionId: session.thebeSessionId,
        }),
      }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: turn_end");
    expect(text).toContain("event: session_end");
  });

  it("remember deny for bash is scoped to the command hash", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "rm -rf /" } }] },
      { kind: "text", text: "after-deny" },
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after-ls" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: mockProvider(),
    });
    const first = agent.prompt("dangerous");
    await vi.waitFor(() => {
      expect(agent.pendingPermissionIds().length).toBe(1);
    });
    const sessionId = agent.lastThebeSessionId()!;
    await agent.resolvePermission(sessionId, agent.pendingPermissionIds()[0]!, {
      response: "deny",
      remember: true,
    });
    await first;
    const meta = await agent.getSession(sessionId);
    expect(meta.rememberedPermissions?.bash).toBeUndefined();
    expect(
      Object.keys(meta.rememberedPermissions ?? {}).some((key) =>
        key.startsWith("bash:"),
      ),
    ).toBe(true);

    const second = agent.prompt("safe", { thebeSessionId: sessionId });
    await vi.waitFor(() => {
      expect(agent.pendingPermissionIds().length).toBe(1);
    });
    await agent.resolvePermission(sessionId, agent.pendingPermissionIds()[0]!, {
      response: "allow",
    });
    const result = await second;
    expect(result.text).toBe("after-ls");
  });

  it("interrupt denies pending permissions so the run does not hang", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: mockProvider(),
    });
    const pending = agent.prompt("run");
    await vi.waitFor(() => {
      expect(agent.pendingPermissionIds().length).toBe(1);
    });
    const sessionId = agent.lastThebeSessionId()!;
    await agent.interrupt(sessionId);
    expect(agent.pendingPermissionIds()).toHaveLength(0);
    await Promise.allSettled([pending]);
  });

  it("quiesce rejects DELETE session", async () => {
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    const session = await app.agent.createSession();
    await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/system/quiesce", { method: "POST" }),
    );
    const del = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${session.thebeSessionId}`, {
        method: "DELETE",
      }),
    );
    expect(del.status).toBe(503);
  });

  it("GET /v1/event returns collected session events", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    const session = await app.agent.createSession();
    await app.agent.send("ping", session.thebeSessionId);
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/event"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ type: string }> };
    expect(body.events.some((event) => event.type === "session_end")).toBe(true);
  });

  it("GET message by id and Last-Event-ID reconnect work", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    const session = await app.agent.createSession();
    await app.agent.send("ping", session.thebeSessionId);
    const messages = await app.agent.loadMessages(session.thebeSessionId);
    const user = messages.find((row) => row.role === "user");
    expect(user).toBeDefined();
    const one = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/message/${user!.id}`,
      ),
    );
    expect(one.status).toBe(200);

    const replay = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/log?follow=true`,
        { headers: { "last-event-id": "1" } },
      ),
    );
    const stream = replay.body!.getReader();
    const first = await stream.read();
    await stream.cancel();
    const chunk = new TextDecoder().decode(first.value);
    expect(chunk.includes("id: 0")).toBe(false);
  });

  it("inline lines attachments include the selected source text", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "ok" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: mockProvider(),
    });
    const session = await agent.createSession();
    const data = Buffer.from("alpha\nbeta\ngamma\n").toString("base64");
    await agent.prompt(
      {
        text: "see",
        files: [
          {
            mode: "lines",
            mediaType: "text/plain",
            filename: "notes.txt",
            data,
            lineRange: { start: 2, end: 3 },
          },
        ],
      },
      { thebeSessionId: session.thebeSessionId },
    );
    const user = agent
      .messages()
      .find((row) => row.role === "user");
    expect(user?.text).toContain("beta");
    expect(user?.text).toContain("gamma");
    expect(user?.text).not.toContain("alpha");
  });

  it("GET oauth/login streams auth events", async () => {
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/google/oauth/login"),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toMatch(/event: (auth|device_code|success)/);
  });

  it("remember allow for bash does not authorize a different command", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after-ls" },
      { kind: "tools", calls: [{ name: "bash", args: { command: "rm -rf /" } }] },
      { kind: "text", text: "after-rm" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: mockProvider(),
    });
    const first = agent.prompt("ls");
    await vi.waitFor(() => {
      expect(agent.pendingPermissionIds().length).toBe(1);
    });
    const sessionId = agent.lastThebeSessionId()!;
    await agent.resolvePermission(sessionId, agent.pendingPermissionIds()[0]!, {
      response: "allow",
      remember: true,
    });
    await first;
    const meta = await agent.getSession(sessionId);
    expect(meta.rememberedPermissions?.bash).toBeUndefined();
    expect(
      meta.rememberedPermissions?.[
        `bash:${hashParameters({ command: "ls" })}`
      ],
    ).toBe("allow");

    const second = agent.prompt("rm", { thebeSessionId: sessionId });
    await vi.waitFor(() => {
      expect(agent.pendingPermissionIds().length).toBe(1);
    });
    await agent.resolvePermission(sessionId, agent.pendingPermissionIds()[0]!, {
      response: "deny",
    });
    const result = await second;
    expect(result.text).toBe("after-rm");
  });

  it("createThebeApp default Host allowlist rejects attacker Origin==Host", async () => {
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    const res = await app.handler.handle(
      new Request("http://evil.com:8787/v1/session", {
        method: "POST",
        headers: {
          host: "evil.com:8787",
          origin: "http://evil.com:8787",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects mutating requests whose Host is an unbound attacker on wildcard bind", async () => {
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
      allowedHosts: resolveAllowedHosts("0.0.0.0"),
    });
    const res = await app.handler.handle(
      new Request("http://evil.com:8787/v1/session", {
        method: "POST",
        headers: {
          host: "evil.com:8787",
          origin: "http://evil.com:8787",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("provider /test without static-only opt-in actually probes the model", async () => {
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/api-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "k" }),
      }),
    );
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; message?: string };
    expect(body.ok).toBe(true);
    expect(body.message).toMatch(/probed/);
  });

  it("drainThebeHttpServer waits for server.close after quiesce", async () => {
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    const { server, url } = await listenThebeHttp(app.handler, {
      host: "127.0.0.1",
      port: 0,
    });
    let closed = false;
    const original = server.close.bind(server);
    server.close = ((cb?: (err?: Error) => void) => {
      closed = true;
      return original(cb);
    }) as typeof server.close;
    await drainThebeHttpServer(server, () => app.agent.quiesce());
    expect(closed).toBe(true);
    expect(app.agent.isQuiesced()).toBe(true);
    await expect(fetch(`${url}/v1/health`)).rejects.toThrow();
  });

  it("stopToolCall aborts an in-flight custom tool", async () => {
    let aborted = false;
    const hanging = {
      name: "slow",
      label: "Slow",
      description: "hangs until aborted",
      parameters: { type: "object", properties: {} },
      execute: async (
        _id: string,
        _params: unknown,
        signal?: AbortSignal,
      ) => {
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            aborted = true;
            reject(new Error("aborted"));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        return { content: [{ type: "text" as const, text: "done" }], details: {} };
      },
    };
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "slow", id: "call-1" }] },
      { kind: "text", text: "after" },
    ]);
    const session = await fake.runtime.createSession({
      customTools: [hanging],
      builtinTools: ["bash"],
    });
    const pending = session.prompt("go");
    await vi.waitFor(async () => {
      await session.stopToolCall("call-1");
      expect(aborted).toBe(true);
    });
    await Promise.allSettled([pending]);
    expect(aborted).toBe(true);
  });

  it("wrapCustomTools is the only audit writer for container tools", async () => {
    const records: unknown[] = [];
    const policy = createPolicyEngine({ now: () => new Date() });
    const audit = {
      append: async (record: unknown) => {
        records.push(record);
      },
    };
    const tools = wrapCustomTools(
      createContainerTools(mockProvider(), { policy, callerId: "test" }),
      { policy, audit: audit as never },
    );
    await tools[0]!.execute("c1", {});
    expect(records).toHaveLength(1);
  });

  it("idle reap disposes opened sessions when configured", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const fake = createFakeRuntime();
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: mockProvider(),
      now: () => new Date(now),
      sessionIdleTimeoutMs: 1_000,
    });
    await agent.createSession();
    now += 5_000;
    const result = await agent.reapIdleSessions(1_000);
    expect(result.reaped).toBeGreaterThan(0);
  });

  it("branch_in_place on a cold parent keeps the same runtime session", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "one" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: mockProvider(),
    });
    const parent = await agent.createSession();
    await agent.send("hi", parent.thebeSessionId);
    await agent.interrupt(parent.thebeSessionId);
    const child = await agent.fork(parent.thebeSessionId, {
      mode: "branch_in_place",
    });
    expect(child.runtimeSessionId).toBe(parent.runtimeSessionId);
    expect(child.inPlace).toBe(true);
    expect(child.thebeSessionId).not.toBe(parent.thebeSessionId);
  });

  it("quiesce blocks remaining auth writes including DELETE /v1/auth", async () => {
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/system/quiesce", { method: "POST" }),
    );
    const del = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/auth/fake", { method: "DELETE" }),
    );
    expect(del.status).toBe(503);
    const key = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/provider/fake/api-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "x" }),
      }),
    );
    expect(key.status).toBe(503);
    const mcp = await app.handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "container.list", arguments: {} },
        }),
      }),
    );
    expect(mcp.status).toBe(503);
  });
});
