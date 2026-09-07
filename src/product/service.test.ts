import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../providers/index.ts";
import { createFakeRuntime } from "../runtime/fake-runtime.ts";
import { createThebeApp } from "./app.ts";
import { createThebeProduct } from "./service.ts";

const CANARY = "sk-canary-s3cret-leak";

function emptyProvider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("inspect not used");
    },
    getContainerLogs: async () => {
      throw new Error("logs not used");
    },
    getStatusSummary: async () => {
      throw new Error("summary not used");
    },
  };
}

describe("Thebe product service (fake runtime)", () => {
  it("asks through Thebe-owned events, not Pi event types", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const result = await product.ask("ping");
    expect(result.text).toBe("pong");
    expect(result.events.map((event) => event.type)).toEqual([
      "text_delta",
      "turn_end",
      "session_end",
    ]);
    expect(JSON.stringify(result.events)).not.toContain("message_update");
    expect(JSON.stringify(result.events)).not.toContain("assistantMessageEvent");
  });

  it("registers Pi built-ins together with container tools", () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    expect(product.toolNames()).toEqual(
      expect.arrayContaining([
        "ls",
        "bash",
        "read",
        "edit",
        "write",
        "container.list",
        "container.inspect",
      ]),
    );
  });

  it("redacts a canary secret from custom-tool success events and messages", async () => {
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      inspectContainer: async () => ({
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        config: { env: [`API_TOKEN=${CANARY}`] },
      }),
    };
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [{ name: "container.inspect", args: { id: "abc123" } }],
      },
      { kind: "text", text: "inspected" },
    ]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider,
    });
    const result = await product.ask("inspect");
    expect(result.text).toBe("inspected");
    const dumped = JSON.stringify({
      events: result.events,
      messages: product.messages(),
    });
    expect(dumped).not.toContain(CANARY);
    expect(dumped).toContain("***REDACTED***");
  });

  it("HTTP and TUI share the same ask function from createThebeApp", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "shared" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: emptyProvider(),
      version: "0.1.0",
    });
    const http = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    expect(http.status).toBe(200);
    await expect(http.json()).resolves.toEqual({
      text: "shared",
      tools: [],
    });
    expect(app.ask).toBeTypeOf("function");
  });

  it("ProductStore files contain mapping keys only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-meta-"));
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "ok" }]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
      productStoreDir: dir,
    });
    await product.ask("hi");
    const listed = await product.listSessions();
    expect(listed).toHaveLength(1);
    const raw = await readFile(
      join(dir, `${listed[0]!.thebeSessionId}.json`),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ["runtimeId", "runtimeSessionId", "thebeSessionId"].sort(),
    );
    expect(raw).not.toContain("pong");
    expect(raw).not.toContain("transcript");
  });

  it("fork leaves parent messages unchanged", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "parent-turn" }]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await product.ask("one");
    const parentId = product.lastThebeSessionId()!;
    const before = product.messages().map((message) => message.text);
    await product.fork(parentId);
    const parent = fake.snapshot(
      (await product.listSessions()).find((row) => row.thebeSessionId === parentId)!
        .runtimeSessionId,
    );
    expect(parent.messages.map((message) => message.text)).toEqual(before);
  });

  it("compact then continue", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await product.ask("one");
    await product.compact();
    const continued = await product.ask("two");
    expect(continued.text).toBe("second");
    expect(fake.compactCalls()).toBe(1);
  });

  it("records enabled skill identity/version/source in audit and does not auto-load extras", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const fake = createFakeRuntime();
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
      auditPath,
    });
    expect(product.enabledResources()).toEqual([]);
    await product.enableResource({
      kind: "skill",
      identity: "homelab-status",
      version: "1.0.0",
      source: "thebe://skills/homelab-status",
    });
    const row = JSON.parse(
      (await readFile(auditPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    expect(row).toMatchObject({
      method: "resource.enable",
      identity: "homelab-status",
      version: "1.0.0",
      source: "thebe://skills/homelab-status",
    });
    expect(product.enabledResources()).toHaveLength(1);
  });

  it("MCP tools/call uses the same product invokeTool path", async () => {
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      getStatusSummary: async () => ({
        totalContainers: 4,
        runningContainers: 2,
        pausedContainers: 0,
        exitedContainers: 2,
        lastUpdated: 1,
      }),
    };
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider,
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
    const body = (await res.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(body.result?.content?.[0]?.text).toContain("runningContainers");
  });
});
