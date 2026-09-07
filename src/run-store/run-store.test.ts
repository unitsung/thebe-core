import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createThebeAgent } from "../ask/index.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import { createRunStore } from "./index.ts";

function emptyProvider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("not used");
    },
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => {
      throw new Error("not used");
    },
  };
}

describe("RunStore", () => {
  it("save then load returns the same snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-run-"));
    const store = createRunStore(dir, () => new Date("2026-09-05T12:00:00Z"));
    await store.save({
      runId: "run-1",
      systemPrompt: "You are Thebe.",
      messages: [],
      tools: ["container.list"],
      status: "done",
    });
    const loaded = await store.load("run-1");
    expect(loaded.status).toBe("done");
    expect(loaded.timestamp).toBe("2026-09-05T12:00:00.000Z");
    expect(loaded.tools).toEqual(["container.list"]);
    await expect(store.list(0, 1)).resolves.toEqual(["run-1"]);
  });

  it("does not count failure sentinel messages toward token totals", () => {
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
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "boom",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } as never,
    ]);
    expect(store.tokenTotals().totalTokens).toBe(15);
    expect(store.tokenTotals().estimatedTokens).toBe(0);
  });

  it("Ask success leaves a loadable snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-run-"));
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
    const files = await readdir(dir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const store = createRunStore(dir);
    const ids = await store.list();
    const snap = await store.load(ids[0] ?? "");
    expect(snap.status).toBe("done");
    expect(snap.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("Ask abort/error still snapshots via agent_end (§15 #14)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-run-"));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const thebe = createThebeAgent({
      models,
      model: faux.getModel(),
      streamFn: async () => createAssistantMessageEventStream(),
      provider: emptyProvider(),
      runStoreDir: dir,
      now: () => new Date("2026-09-05T12:00:00Z"),
      ttfbMs: 40,
      idleMs: 1000,
      watchdogMs: 40,
    });
    await expect(thebe.ask("ping")).rejects.toThrow();
    const store = createRunStore(dir);
    const ids = await store.list();
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const snap = await store.load(ids[0] ?? "");
    expect(["failed", "force-killed"]).toContain(snap.status);
    expect(snap.tools).toEqual([
      "container.list",
      "container.inspect",
      "container.logs",
      "container.status_summary",
    ]);
  });
});
