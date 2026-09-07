import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { isFailureSentinel } from "./convert.ts";
import { createThebeAgent } from "../ask/ask.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import { createRunStore } from "../run-store/index.ts";

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

describe("AgentHarness hook parity", () => {
  it("beforeToolCall block has no terminate field and shouldStopAfterTurn stops", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const thebe = createThebeAgent({
      models,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      provider: emptyProvider(),
      maxToolCalls: 1,
    });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.list", {}),
        fauxToolCall("container.list", {}),
      ]),
      fauxAssistantMessage("should not run"),
    ]);
    const reply = await thebe.ask("list twice");
    expect(reply).not.toBe("should not run");
    const blocks = thebe.beforeToolResults().filter((row) => row.block);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const result of thebe.beforeToolResults()) {
      expect("terminate" in result).toBe(false);
    }
    expect(faux.getPendingResponseCount()).toBe(1);
    const toolResults = thebe.messages().filter((m) => m.role === "toolResult");
    expect(JSON.stringify(toolResults)).not.toContain('"terminate"');
  });
});

describe("AgentHarness branch isolation", () => {
  it("writes on a fork leave the parent Run and RunStore snapshot unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-fork-"));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const thebe = createThebeAgent({
      models,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      provider: emptyProvider(),
      runStoreDir: dir,
      now: () => new Date("2026-09-05T12:00:00Z"),
    });
    faux.setResponses([fauxAssistantMessage("pong")]);
    await expect(thebe.ask("ping")).resolves.toBe("pong");
    const parentMessages = structuredClone(thebe.messages());
    const runId = thebe.lastRunId();
    expect(runId).toBeTruthy();
    const store = createRunStore(dir);
    const parentSnap = await store.load(runId ?? "");
    await thebe.forkBranch("alt");
    await thebe.appendOnBranch("alt", {
      role: "user",
      content: [{ type: "text", text: "fork-only write" }],
      timestamp: Date.now(),
    });
    const forkMessages = await thebe.branchMessages("alt");
    expect(
      forkMessages.some(
        (message) =>
          "content" in message &&
          JSON.stringify(message.content).includes("fork-only write"),
      ),
    ).toBe(true);
    expect(thebe.messages()).toEqual(parentMessages);
    const after = await store.load(runId ?? "");
    expect(after.messages).toEqual(parentSnap.messages);
    expect(after.status).toBe(parentSnap.status);
    expect(after.tokenTotals).toEqual(parentSnap.tokenTotals);
  });
});

describe("AgentHarness compaction", () => {
  it("compacts near contextWindow - reserveMargin before overflow terminate-and-report", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", contextWindow: 2_000, maxTokens: 256 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const thebe = createThebeAgent({
      models,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      provider: emptyProvider(),
      compaction: {
        enabled: true,
        reserveTokens: 800,
        keepRecentTokens: 40,
      },
    });
    const bulky = "x".repeat(10_000);
    faux.setResponses([
      fauxAssistantMessage(bulky),
      fauxAssistantMessage("## Goal\ncompacted"),
    ]);
    const reply = await thebe.ask("fill context");
    expect(reply.length).toBeGreaterThan(0);
    expect(thebe.compactionReasons().length).toBeGreaterThanOrEqual(1);
    // Ledger may still show the bulky turn; compaction must have run instead
    // of a v0 terminate-and-report stop.
    const sentinel = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "" }],
      stopReason: "error" as const,
      errorMessage: "boom",
      timestamp: 1,
    };
    expect(isFailureSentinel(sentinel as never)).toBe(true);
    const store = createRunStore();
    store.recordMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stopReason: "stop",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } as never,
      sentinel as never,
    ]);
    expect(store.tokenTotals().totalTokens).toBe(15);
    expect(thebe.messages().some((message) => isFailureSentinel(message))).toBe(
      false,
    );
  });
});
