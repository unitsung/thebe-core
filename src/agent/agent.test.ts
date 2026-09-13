import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createThebeAgent } from "./index.ts";
import type { ContainerInfoProvider } from "./capabilities/containers.ts";
import { createFakeRuntime } from "../testing/runtime/index.ts";

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

describe("Thebe agent", () => {
  it("returns the runtime reply through the agent layer", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const thebe = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await expect(thebe.send("ping")).resolves.toMatchObject({ text: "pong" });
  });

  it("registers Pi built-ins plus the four container tools", () => {
    const fake = createFakeRuntime();
    const thebe = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    expect(thebe.toolNames()).toEqual(
      expect.arrayContaining([
        "bash",
        "read",
        "container.list",
        "container.inspect",
        "container.logs",
        "container.status_summary",
      ]),
    );
  });

  it("inspect redacts secret env in the tool result", async () => {
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      inspectContainer: async () => ({
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        config: { env: ["NODE_ENV=production", "API_TOKEN=s3cret"] },
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
    const thebe = createThebeAgent({ runtime: fake.runtime, provider });
    await expect(thebe.send("inspect nginx")).resolves.toMatchObject({ text: "inspected" });
    const toolResult = thebe.messages().find((m) => m.role === "tool");
    expect(toolResult?.text).toContain("API_TOKEN=***REDACTED***");
    expect(toolResult?.text).toContain("NODE_ENV=production");
    expect(toolResult?.text).not.toContain("s3cret");
  });

  it("canary secret never enters audit or runtime-captured tool results", async () => {
    const CANARY = "canary-s3cret";
    const dir = await mkdtemp(join(tmpdir(), "thebe-canary-"));
    const auditPath = join(dir, "audit.jsonl");
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
    const thebe = createThebeAgent({
      runtime: fake.runtime,
      provider,
      auditPath,
    });
    await thebe.send("inspect nginx");
    const audit = await readFile(auditPath, "utf8");
    const exported = await thebe.exportSession();
    const inbound = JSON.stringify(fake.inboundToolResults());
    expect(inbound).not.toContain(CANARY);
    expect(inbound).toContain("***REDACTED***");
    expect(audit).not.toContain(CANARY);
    expect(exported.jsonl).not.toContain(CANARY);
    expect(exported.html).not.toContain(CANARY);
    expect(JSON.stringify(thebe.messages())).not.toContain(CANARY);
  });

  it("refuses container.start when the model tries to call it", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [{ name: "container.start", args: { id: "abc123" } }],
      },
      { kind: "text", text: "stopped" },
    ]);
    const thebe = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await expect(thebe.send("start nginx")).resolves.toMatchObject({ text: "stopped" });
    const toolResult = thebe.messages().find((m) => m.role === "tool");
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.toolName).toBe("container.start");
  });

  it("appends JSONL audit without raw secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      inspectContainer: async () => ({
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        config: { env: ["API_TOKEN=s3cret"] },
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
    const thebe = createThebeAgent({
      runtime: fake.runtime,
      provider,
      auditPath,
      now: () => new Date("2026-09-05T12:00:00Z"),
      callerId: "agent-1",
    });
    await thebe.send("inspect nginx");
    const lines = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const inspectLine = lines.find((row) => row.method === "container.inspect");
    expect(inspectLine).toMatchObject({
      timestamp: "2026-09-05T12:00:00.000Z",
      method: "container.inspect",
      redactionFired: true,
    });
    expect(JSON.stringify(lines)).not.toContain("s3cret");
  });

  it("budget exhaust stops further custom tools without terminate", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [
          { name: "container.list", args: {} },
          { name: "container.list", args: {} },
        ],
      },
      { kind: "text", text: "should not run" },
    ]);
    const thebe = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      maxToolCalls: 1,
    });
    const reply = await thebe.send("list twice");
    expect(reply.text).not.toBe("should not run");
    const toolResults = thebe.messages().filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(2);
    expect(JSON.stringify(toolResults)).not.toContain('"terminate"');
  });

  it("hanging stream reaches terminal via StreamGuard", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }]);
    const thebe = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      ttfbMs: 40,
      idleMs: 1000,
      watchdogMs: 40,
    });
    const start = Date.now();
    await expect(thebe.send("ping")).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});
