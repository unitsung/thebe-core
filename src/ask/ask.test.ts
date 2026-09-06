import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  contentText,
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createThebeAgent } from "./ask.ts";
import { createRunStore } from "../run-store/index.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";

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

function thebeWithFaux(
  provider: ContainerInfoProvider = emptyProvider(),
  extras: {
    auditPath?: string;
    now?: () => Date;
    callerId?: string;
    runStoreDir?: string;
    maxToolCalls?: number;
    ttfbMs?: number;
    idleMs?: number;
    watchdogMs?: number;
    streamFn?: StreamFn;
  } = {},
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const { streamFn, ...rest } = extras;
  const thebe = createThebeAgent({
    model: faux.getModel(),
    streamFn: streamFn ?? models.streamSimple.bind(models),
    provider,
    ...rest,
  });
  return { faux, thebe, models };
}

describe("Ask", () => {
  it("returns the Pi agent's reply", async () => {
    const { faux, thebe } = thebeWithFaux();
    faux.setResponses([fauxAssistantMessage("pong")]);
    await expect(thebe.ask("ping")).resolves.toBe("pong");
  });

  it("runs tools sequentially", () => {
    const { thebe } = thebeWithFaux();
    expect(thebe.toolExecution()).toBe("sequential");
  });

  it("registers only the four read-only container tools", async () => {
    const { thebe } = thebeWithFaux();
    expect(thebe.toolNames()).toEqual([
      "container.list",
      "container.inspect",
      "container.logs",
      "container.status_summary",
    ]);
    expect(thebe.toolNames()).not.toContain("bash");
    expect(thebe.toolNames()).not.toContain("read");
    expect(thebe.toolNames()).not.toContain("edit");
    expect(thebe.toolNames()).not.toContain("write");
    expect(thebe.toolNames()).not.toContain("container.start");
  });

  it("refuses bash when the model tries to call it", async () => {
    const { faux, thebe } = thebeWithFaux();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })]),
      fauxAssistantMessage("done"),
    ]);
    const reply = await thebe.ask("list files");
    expect(reply).toBe("done");
    const toolResult = thebe.messages().find((m) => m.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.toolName).toBe("bash");
    }
  });

  it("Ask inspect redacts secret env in the tool result", async () => {
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
    const { faux, thebe } = thebeWithFaux(provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.inspect", { id: "abc123" }),
      ]),
      fauxAssistantMessage("inspected"),
    ]);
    await expect(thebe.ask("inspect nginx")).resolves.toBe("inspected");
    const toolResult = thebe.messages().find((m) => m.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      const text = contentText(toolResult.content);
      expect(text).toContain("API_TOKEN=***REDACTED***");
      expect(text).toContain("NODE_ENV=production");
      expect(text).not.toContain("s3cret");
    }
  });

  it("Ask logs redacts tokens and truncates with the spec marker", async () => {
    const hex = "a".repeat(40);
    const lines = [
      ...Array.from({ length: 201 }, (_, i) => `L${i}`),
      `token=sk-live-abc123 hex=${hex}`,
    ];
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      getContainerLogs: async () => lines.join("\n"),
    };
    const { faux, thebe } = thebeWithFaux(provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.logs", { id: "abc123" }),
      ]),
      fauxAssistantMessage("logged"),
    ]);
    await expect(thebe.ask("show logs")).resolves.toBe("logged");
    const toolResult = thebe.messages().find((m) => m.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      const text = contentText(toolResult.content);
      expect(text).toContain("[... truncated ...]");
      expect(text).toContain("token=***REDACTED***");
      expect(text).toContain("hex=***REDACTED***");
      expect(text).not.toContain("sk-live-abc123");
    }
  });

  it("refuses container.start when the model tries to call it", async () => {
    const { faux, thebe } = thebeWithFaux();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("container.start", { id: "abc123" })]),
      fauxAssistantMessage("stopped"),
    ]);
    await expect(thebe.ask("start nginx")).resolves.toBe("stopped");
    const toolResult = thebe.messages().find((m) => m.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.toolName).toBe("container.start");
    }
  });

  it("refuses the 1001st container.logs call in the same day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      getContainerLogs: async () => "ok",
    };
    const { faux, thebe } = thebeWithFaux(provider, {
      auditPath,
      now: () => new Date("2026-09-05T12:00:00Z"),
      callerId: "agent-1",
    });
    for (let i = 0; i < 1000; i++) {
      faux.appendResponses([
        fauxAssistantMessage([fauxToolCall("container.logs", { id: "abc123" })]),
        fauxAssistantMessage("ok"),
      ]);
      await thebe.ask("logs");
    }
    faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("container.logs", { id: "abc123" })]),
      fauxAssistantMessage("capped"),
    ]);
    await expect(thebe.ask("logs again")).resolves.toBe("capped");
    const toolResults = thebe
      .messages()
      .filter((m) => m.role === "toolResult");
    const last = toolResults.at(-1);
    expect(last?.role).toBe("toolResult");
    if (last?.role === "toolResult") {
      expect(last.isError).toBe(true);
    }
  });

  it("appends JSONL audit without raw secrets after success and refusal", async () => {
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
    const { faux, thebe } = thebeWithFaux(provider, {
      auditPath,
      now: () => new Date("2026-09-05T12:00:00Z"),
      callerId: "agent-1",
    });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.inspect", { id: "abc123" }),
      ]),
      fauxAssistantMessage("inspected"),
      fauxAssistantMessage([fauxToolCall("container.start", { id: "abc123" })]),
      fauxAssistantMessage("denied"),
    ]);
    await thebe.ask("inspect nginx");
    await thebe.ask("start nginx");
    const lines = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const inspectLine = lines.find((row) => row.method === "container.inspect");
    expect(inspectLine).toMatchObject({
      timestamp: "2026-09-05T12:00:00.000Z",
      method: "container.inspect",
      redactionFired: true,
    });
    expect(inspectLine).toHaveProperty("parameterHash");
    expect(inspectLine).toHaveProperty("responseBytes");
    expect(inspectLine).toHaveProperty("budgetConsumed");
    const startLine = lines.find((row) => row.method === "container.start");
    expect(startLine).toMatchObject({
      timestamp: "2026-09-05T12:00:00.000Z",
      method: "container.start",
      budgetConsumed: 0,
      redactionFired: false,
    });
    expect(startLine).toHaveProperty("parameterHash");
    expect(startLine).toHaveProperty("responseBytes");
    const dumped = JSON.stringify(lines);
    expect(dumped).not.toContain("s3cret");
    expect(dumped).not.toContain("API_TOKEN=");
  });

  it("canary secret is absent from audit and from later provider bodies (§15 #7)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      inspectContainer: async () => ({
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        config: { env: ["API_TOKEN=canary-s3cret"] },
      }),
    };
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const bodies: string[] = [];
    const inner = models.streamSimple.bind(models);
    const thebe = createThebeAgent({
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        bodies.push(JSON.stringify(context));
        return inner(model, context, options);
      },
      provider,
      auditPath,
      now: () => new Date("2026-09-05T12:00:00Z"),
      callerId: "agent-1",
    });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.inspect", { id: "abc123" }),
      ]),
      fauxAssistantMessage("inspected"),
    ]);
    await thebe.ask("inspect nginx");
    const audit = await readFile(auditPath, "utf8");
    expect(audit).not.toContain("canary-s3cret");
    expect(bodies.join("\n")).not.toContain("canary-s3cret");
    expect(bodies.length).toBeGreaterThanOrEqual(2);
  });

  it("truncates huge logs, marks them, and audits the truncation (§15 #8)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const lines = Array.from({ length: 250 }, (_, i) => `L${i}`);
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      getContainerLogs: async () => lines.join("\n"),
    };
    const { faux, thebe } = thebeWithFaux(provider, {
      auditPath,
      now: () => new Date("2026-09-05T12:00:00Z"),
      callerId: "agent-1",
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("container.logs", { id: "abc123" })]),
      fauxAssistantMessage("logged"),
    ]);
    await thebe.ask("show logs");
    const toolResult = thebe.messages().find((m) => m.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      expect(contentText(toolResult.content)).toContain("[... truncated ...]");
    }
    const rows = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; redactionFired?: boolean });
    const logsLine = rows.find((row) => row.method === "container.logs");
    expect(logsLine?.redactionFired).toBe(true);
  });

  it("budget exhaust stops the loop via shouldStopAfterTurn with no terminate (§15 #5/#13)", async () => {
    const { faux, thebe } = thebeWithFaux(emptyProvider(), { maxToolCalls: 1 });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.list", {}),
        fauxToolCall("container.list", {}),
      ]),
      fauxAssistantMessage("should not run"),
    ]);
    const reply = await thebe.ask("list twice");
    expect(reply).not.toBe("should not run");
    const toolResults = thebe.messages().filter((m) => m.role === "toolResult");
    expect(toolResults.length).toBe(2);
    expect(toolResults.some((m) => "terminate" in m)).toBe(false);
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(JSON.stringify(toolResults)).not.toContain('"terminate"');
  });

  it("Ask hanging stream reaches terminal with a snapshot in ≤10s (§15 #1/#14)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-run-"));
    const start = Date.now();
    const { thebe } = thebeWithFaux(emptyProvider(), {
      runStoreDir: dir,
      now: () => new Date("2026-09-05T12:00:00Z"),
      ttfbMs: 40,
      idleMs: 1000,
      watchdogMs: 40,
      streamFn: async () => createAssistantMessageEventStream(),
    });
    await expect(thebe.ask("ping")).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(10_000);
    const files = await readdir(dir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const store = createRunStore(dir);
    const ids = await store.list();
    const snap = await store.load(ids[0] ?? "");
    expect(["failed", "force-killed"]).toContain(snap.status);
    expect(snap.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("Ask streamFn throw does not hang and is not returned as a reply (§15 #2/#15)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-run-"));
    const { thebe } = thebeWithFaux(emptyProvider(), {
      runStoreDir: dir,
      now: () => new Date("2026-09-05T12:00:00Z"),
      streamFn: async () => {
        throw new Error("boom");
      },
    });
    await expect(thebe.ask("ping")).rejects.toThrow(/boom/);
    const store = createRunStore(dir);
    const ids = await store.list();
    const snap = await store.load(ids[0] ?? "");
    expect(snap.status).toBe("failed");
    expect(snap.tokenTotals.totalTokens).toBe(0);
    expect(snap.tokenTotals.estimatedTokens).toBe(0);
  });

  it("after abort, no further LLM calls in that run (§15 #11)", async () => {
    let calls = 0;
    const { thebe } = thebeWithFaux(emptyProvider(), {
      ttfbMs: 40,
      idleMs: 1000,
      watchdogMs: 40,
      streamFn: async () => {
        calls += 1;
        return createAssistantMessageEventStream();
      },
    });
    await thebe.ask("ping").catch(() => {});
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(1);
  });

  it("after an aborted turn, the next Ask succeeds without the aborted assistant (§15 #4)", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let calls = 0;
    const inner = models.streamSimple.bind(models);
    const seen: string[] = [];
    const thebe = createThebeAgent({
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        calls += 1;
        if (calls === 1) {
          return createAssistantMessageEventStream();
        }
        seen.push(JSON.stringify(context.messages));
        return inner(model, context, options);
      },
      provider: emptyProvider(),
      ttfbMs: 40,
      idleMs: 1000,
      watchdogMs: 40,
    });
    await expect(thebe.ask("one")).rejects.toThrow();
    faux.setResponses([fauxAssistantMessage("pong")]);
    await expect(thebe.ask("two")).resolves.toBe("pong");
    expect(seen.join("\n")).not.toMatch(/"stopReason":"aborted"/);
    expect(seen.join("\n")).not.toMatch(/"stopReason":"error"/);
  });
});



