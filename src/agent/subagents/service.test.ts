import { describe, expect, it, vi } from "vitest";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import type { SubagentProfile } from "./catalog.ts";
import { createSubagentRunManager } from "./service.ts";

const profile: SubagentProfile = {
  name: "test-worker",
  description: "test",
  filePath: "",
  scope: "builtin",
  systemPrompt: "work",
  tools: [],
  maxTurns: 2,
};

describe("subagent slots", () => {
  it("keeps the human reserve free when background workers saturate their lane", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }, { kind: "hang" }]);
    const manager = createSubagentRunManager({
      maxConcurrent: 2,
      maxPerParent: 2,
      createSession: async () =>
        fake.runtime.createSession({
          customTools: [],
          builtinTools: [],
          inMemory: true,
        }),
    });

    const backgroundA = manager.spawn({
      profile,
      task: "background A",
      parentSessionId: "parent",
      background: true,
    });
    const backgroundB = manager.spawn({
      profile,
      task: "background B",
      parentSessionId: "parent",
      background: true,
    });
    const human = manager.spawn({
      profile,
      task: "human",
      parentSessionId: "parent",
    });

    await vi.waitFor(() => {
      expect(manager.get(backgroundA.runId)?.status).toBe("running");
      expect(manager.get(backgroundB.runId)?.status).toBe("queued");
      expect(manager.get(human.runId)?.status).toBe("running");
    });
    expect(manager.limits).toMatchObject({
      maxConcurrent: 2,
      maxBackground: 1,
      humanReserve: 1,
    });

    await manager.cancel(human.runId, "parent");
    await manager.cancel(backgroundA.runId, "parent");
    await manager.cancel(backgroundB.runId, "parent");
  });

  it("keeps an explicit turn budget above the old fixed ceiling", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "done" }]);
    const manager = createSubagentRunManager({
      createSession: async () =>
        fake.runtime.createSession({
          customTools: [],
          builtinTools: [],
          inMemory: true,
        }),
    });

    const run = manager.spawn({
      profile: { ...profile, maxTurns: 75 },
      task: "long task",
      parentSessionId: "parent",
    });

    expect(run.maxTurns).toBe(75);
    await expect(manager.wait(run.runId)).resolves.toMatchObject({
      status: "completed",
      maxTurns: 75,
      turns: 1,
    });
  });
});
