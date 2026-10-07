import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createThebeAgent } from "../create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

describe("provider task output Artifacts", () => {
  it("keeps task discovery visible when output exceeds the Artifact limit", async () => {
    const agent = createThebeAgent({ runtime: createFakeRuntime().runtime,
      provider: { listContainers: async () => [], inspectContainer: async () => { throw new Error("unused"); }, getContainerLogs: async () => { throw new Error("unused"); }, getStatusSummary: async () => { throw new Error("unused"); } },
      backgroundTaskProviders: [{ service: "native", list: async () => [{ id: "large", status: "stopped", output: { content: "x".repeat(600000) } }], stop: async () => {}, stopAll: async () => {} }],
    });
    const tasks = await agent.listAllBackgroundTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "large", status: "stopped", error: "Task output could not be retained" });
    expect(tasks[0]?.artifactId).toBeUndefined();
    await agent.quiesce();
  });
  it("redacts and persists the provider's own output once across concurrent reads and recreation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-task-output-"));
    const create = () => createThebeAgent({ agentStoreDir: dir, runtime: createFakeRuntime().runtime,
      provider: { listContainers: async () => [], inspectContainer: async () => { throw new Error("unused"); }, getContainerLogs: async () => { throw new Error("unused"); }, getStatusSummary: async () => { throw new Error("unused"); } },
      backgroundTaskProviders: [{ service: "native", list: async () => [{ id: "task-1", status: "stopped", output: { content: "Authorization: Bearer secret-canary-token", contentType: "text/plain" } }], stop: async () => {}, stopAll: async () => {} }],
    });
    try {
      const first = create();
      const results = await Promise.all([first.listAllBackgroundTasks(), first.listBackgroundTasks("provider-native")]);
      const id = results[0][0]?.artifactId;
      expect(id).toBeDefined(); expect(results[1][0]?.artifactId).toBe(id);
      expect((await first.getArtifactContent(id!))?.content).not.toContain("secret-canary-token");
      expect(await first.listArtifacts({ kind: "task_output" })).toHaveLength(1);
      await first.quiesce();
      const restored = create();
      expect((await restored.listAllBackgroundTasks())[0]?.artifactId).toBe(id);
      expect(await restored.listArtifacts({ kind: "task_output" })).toHaveLength(1);
      await restored.quiesce();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
