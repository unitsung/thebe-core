import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

const provider: ContainerInfoProvider = {
  listContainers: async () => [],
  inspectContainer: async (id) => ({
    id,
    name: "x",
    image: "x",
    state: "exited",
    config: {},
  }),
  getContainerLogs: async () => "",
  getStatusSummary: async () => ({
    totalContainers: 0,
    runningContainers: 0,
    pausedContainers: 0,
    exitedContainers: 0,
    lastUpdated: 1,
  }),
  restartContainer: async () => {},
};

/** A pinned model must survive a Core restart even when the runtime never wrote the session (no prompt yet). */
describe("session model pin", () => {
  it("re-applies the pinned model when a session comes back on the default", async () => {
    const fake = createFakeRuntime({
      models: [
        { providerId: "fake", modelId: "default-model", displayName: "Default" },
        { providerId: "fake", modelId: "pinned-model", displayName: "Pinned" },
      ],
    });
    const dir = await mkdtemp(join(tmpdir(), "thebe-model-pin-"));
    const first = createThebeApp({
      runtime: fake.runtime,
      provider,
      agentStoreDir: dir,
    });
    const meta = await first.agent.createSession({
      title: "pinned",
      model: { providerId: "fake", modelId: "pinned-model" },
    });
    expect((await first.agent.getSession(meta.thebeSessionId)).model).toEqual({
      providerId: "fake",
      modelId: "pinned-model",
    });

    // The restarted runtime has no record of the session, so it hands back a fresh one on the default.
    let resumedRuntimeId = "";
    const lossy = {
      ...fake.runtime,
      async resumeSession(
        _id: string,
        create: Parameters<typeof fake.runtime.resumeSession>[1]
      ) {
        const fresh = await fake.runtime.createSession({
          ...create,
          model: undefined,
        });
        resumedRuntimeId = fresh.runtimeSessionId;
        return fresh;
      },
    };
    const second = createThebeApp({
      runtime: lossy,
      provider,
      agentStoreDir: dir,
    });
    await second.agent.loadMessages(meta.thebeSessionId);

    expect(fake.snapshot(resumedRuntimeId).model).toMatchObject({
      providerId: "fake",
      modelId: "pinned-model",
    });
  });
});
