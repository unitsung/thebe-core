import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createThebeAgent } from "./index.ts";
import type { ContainerInfoProvider } from "./capabilities/containers.ts";
import type { Source } from "./sources/types.ts";
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

  it("polls and persists a host supplied Source adapter", async () => {
    const event = {
      id: "c".repeat(32),
      source: "local-events",
      kind: "message.created",
      at: "2026-11-06T10:00:00.000Z",
      threads: ["conversation:42"],
      payload: { text: "inspect this" },
      actor: { source: "local-events", id: "person-7" },
      human: true,
      channel: {
        source: "local-events",
        thread: "conversation:42",
        address: { conversationId: "42" },
      },
    };
    const source: Source = {
      id: "local-events",
      scope: "one local conversation",
      read: async () => ({ triggers: [event], cursor: "offset-1" }),
    };
    const thebe = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: emptyProvider(),
      sourceAdapters: [source],
    });

    await vi.waitFor(async () => {
      expect(await thebe.listTriggers()).toEqual([event]);
    });
    expect(thebe.sourceHealth?.()).toEqual([
      expect.objectContaining({ id: source.id, state: "healthy" }),
    ]);
    await thebe.quiesce();
  });

  it("weighs event kinds declared by a host supplied Source", async () => {
    const fake = createFakeRuntime();
    const event = {
      id: "f".repeat(32),
      source: "local-events",
      kind: "message.created",
      at: "2026-11-06T10:00:00.000Z",
      threads: ["conversation:42"],
      payload: { text: "please review this message" },
    };
    let release!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const source: Source = {
      id: "local-events",
      scope: "one local conversation",
      assessedKinds: ["message.created"],
      read: async (cursor) => {
        if (cursor) return { triggers: [], cursor };
        await new Promise<void>((resolve) => {
          release = resolve;
          readStarted();
        });
        return { triggers: [event], cursor: "offset-1" };
      },
    };
    const thebe = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      sourceAdapters: [source],
    });

    try {
      await started;
      const policy = await thebe.setPolicy({ rules: ["Review new messages"] });
      fake.queueTurns([
        {
          kind: "text",
          text: JSON.stringify({
            decision: "accept",
            matched: [policy.rules[0]!.id],
            reason: "The message asks for a review.",
          }),
        },
      ]);
      release();

      await vi.waitFor(async () => {
        expect(await thebe.listDecisions()).toMatchObject([
          expect.objectContaining({
            triggerIds: [event.id],
            outcome: "ignore",
            wouldAccept: true,
          }),
        ]);
      });
    } finally {
      release();
      await thebe.quiesce();
    }
  });

  it("routes explicitly admitted Source requests to Main Session without Eval", async () => {
    const fake = createFakeRuntime();
    const event = {
      id: "b".repeat(32),
      source: "direct-messages",
      kind: "message.created",
      at: "2026-11-06T10:00:00.000Z",
      threads: ["conversation:42"],
      payload: { text: "Please inspect this" },
      actor: { source: "direct-messages", id: "person-7" },
      human: true,
      addressed: "direct" as const,
      channel: {
        source: "direct-messages",
        thread: "conversation:42",
        address: { conversationId: "42" },
      },
    };
    let release!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const source: Source = {
      id: "direct-messages",
      scope: "one conversation",
      assessedKinds: ["message.created"],
      admit: (trigger) =>
        trigger.human && trigger.addressed === "direct" ? "explicit" : "ignore",
      read: async (cursor) => {
        if (cursor) return { triggers: [], cursor };
        await new Promise<void>((resolve) => {
          release = resolve;
          readStarted();
        });
        return { triggers: [event], cursor: "offset-1" };
      },
    };
    const thebe = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      sourceAdapters: [source],
    });

    try {
      await started;
      await thebe.setPolicy({
        rules: ["Inspect explicitly addressed requests"],
        acceptMode: "auto",
      });
      fake.queueTurns([{ kind: "text", text: "Main Session ready." }]);
      await thebe.askMainSession("Initialize the Main Session.");
      const session = await thebe.getSession("thebe-main");
      fake.queueTurns([{ kind: "text", text: "No additional action." }]);
      release();

      await vi.waitFor(() => {
        const messages = fake.snapshot(session.runtimeSessionId).messages;
        expect(JSON.stringify(messages)).toContain("admission: explicit");
        expect(JSON.stringify(messages)).toContain(event.id);
      });
      expect(await thebe.listDecisions()).toEqual([]);
    } finally {
      release();
      await thebe.quiesce();
    }
  });

  it("quiesce aborts an in-flight Source read and waits for it to settle", async () => {
    let signal: AbortSignal | undefined;
    let release!: (result: {
      triggers: import("./sources/types.ts").Trigger[];
      cursor: string;
    }) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const source: Source = {
      id: "slow-events",
      scope: "test source",
      read: (_cursor, readSignal) => {
        signal = readSignal;
        readStarted();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const thebe = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: emptyProvider(),
      sourceAdapters: [source],
    });

    let quiescing: Promise<void> | undefined;
    try {
      await started;
      let quiesced = false;
      quiescing = thebe.quiesce().then(() => {
        quiesced = true;
      });
      expect(signal?.aborted).toBe(true);
      await Promise.resolve();
      expect(quiesced).toBe(false);
      release({ triggers: [], cursor: "offset-1" });
      await quiescing;
      expect(await thebe.listTriggers()).toEqual([]);
    } finally {
      release({ triggers: [], cursor: "offset-1" });
      if (quiescing) await quiescing;
      else await thebe.quiesce();
    }
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
        "container_list",
        "container_inspect",
        "container_logs",
        "container_status_summary",
      ])
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
        calls: [{ name: "container_inspect", args: { id: "abc123" } }],
      },
      { kind: "text", text: "inspected" },
    ]);
    const thebe = createThebeAgent({ runtime: fake.runtime, provider });
    await expect(thebe.send("inspect nginx")).resolves.toMatchObject({
      text: "inspected",
    });
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
        calls: [{ name: "container_inspect", args: { id: "abc123" } }],
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

  it("refuses container_start when the model tries to call it", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [{ name: "container_start", args: { id: "abc123" } }],
      },
      { kind: "text", text: "stopped" },
    ]);
    const thebe = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await expect(thebe.send("start nginx")).resolves.toMatchObject({
      text: "stopped",
    });
    const toolResult = thebe.messages().find((m) => m.role === "tool");
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.toolName).toBe("container_start");
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
        calls: [{ name: "container_inspect", args: { id: "abc123" } }],
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
    const inspectLine = lines.find((row) => row.method === "container_inspect");
    expect(inspectLine).toMatchObject({
      timestamp: "2026-09-05T12:00:00.000Z",
      method: "container_inspect",
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
          { name: "container_list", args: {} },
          { name: "container_list", args: {} },
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
