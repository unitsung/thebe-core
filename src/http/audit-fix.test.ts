import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../audit/audit-log.ts";
import { createThebeApp } from "../product/app.ts";
import { createThebeProduct } from "../product/service.ts";
import { assertValidSessionId, createProductStore } from "../product/store.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import { createFakeRuntime } from "../runtime/fake-runtime.ts";
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

  it("ProductStore refuses traversal ids", async () => {
    const store = createProductStore("/tmp/thebe-store-test");
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
    const session = await app.product.createSession();
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
    expect(app.product.pendingPermissionIds()).toHaveLength(0);
  });

  it("SSE /v1/messages closes after session_end, not turn_end", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "hello" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    const session = await app.product.createSession();
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
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: mockProvider(),
    });
    const first = product.prompt("dangerous");
    await vi.waitFor(() => {
      expect(product.pendingPermissionIds().length).toBe(1);
    });
    const sessionId = product.lastThebeSessionId()!;
    await product.resolvePermission(sessionId, product.pendingPermissionIds()[0]!, {
      response: "deny",
      remember: true,
    });
    await first;
    const meta = await product.getSession(sessionId);
    expect(meta.rememberedPermissions?.bash).toBeUndefined();
    expect(
      Object.keys(meta.rememberedPermissions ?? {}).some((key) =>
        key.startsWith("bash:"),
      ),
    ).toBe(true);

    const second = product.prompt("safe", { thebeSessionId: sessionId });
    await vi.waitFor(() => {
      expect(product.pendingPermissionIds().length).toBe(1);
    });
    await product.resolvePermission(sessionId, product.pendingPermissionIds()[0]!, {
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
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: mockProvider(),
    });
    const pending = product.prompt("run");
    await vi.waitFor(() => {
      expect(product.pendingPermissionIds().length).toBe(1);
    });
    const sessionId = product.lastThebeSessionId()!;
    await product.interrupt(sessionId);
    expect(product.pendingPermissionIds()).toHaveLength(0);
    await Promise.allSettled([pending]);
  });

  it("quiesce rejects DELETE session", async () => {
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: mockProvider(),
      version: "0.1.0",
    });
    const session = await app.product.createSession();
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
    const session = await app.product.createSession();
    await app.product.send("ping", session.thebeSessionId);
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
    const session = await app.product.createSession();
    await app.product.send("ping", session.thebeSessionId);
    const messages = await app.product.loadMessages(session.thebeSessionId);
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
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: mockProvider(),
    });
    const session = await product.createSession();
    const data = Buffer.from("alpha\nbeta\ngamma\n").toString("base64");
    await product.prompt(
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
    const user = product
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
});
