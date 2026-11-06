import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerInfoProvider,
  ContainerState,
} from "../capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

afterEach(() => vi.useRealTimers());

/** A Docker stand-in that records every restart it is asked for. */
function docker(names: string[]) {
  const state = new Map<string, ContainerState>(
    names.map((n) => [n, "running"])
  );
  const restarted: string[] = [];
  const provider = {
    listContainers: async () =>
      [...state].map(([name, s]) => ({
        id: `id-${name}`,
        name,
        image: "img",
        state: s,
        status: s,
        created: 1,
      })),
    inspectContainer: async (id: string) => ({
      id,
      name: id.slice(3),
      image: "img",
      state: state.get(id.slice(3)) ?? "running",
      config: {},
    }),
    getContainerLogs: async () => "",
    getStatusSummary: async () => ({
      totalContainers: names.length,
      runningContainers: names.length,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
    restartContainer: async (id: string) => {
      restarted.push(id);
      state.set(id.slice(3), "running");
    },
  } as unknown as ContainerInfoProvider;
  return {
    provider,
    restarted,
    set: (n: string, s: ContainerState) => state.set(n, s),
  };
}

async function start(options: { allowed: boolean; list: string[] }) {
  vi.useFakeTimers();
  const d = docker(["emby", "plex"]);
  const fake = createFakeRuntime();
  const app = createThebeApp({
    runtime: fake.runtime,
    provider: d.provider,
    sources: { containerHealth: true, intervalMs: 1000 },
    evalAutoAllowed: options.allowed,
  });
  await vi.advanceTimersByTimeAsync(0); // the Source's baseline
  const policy = await app.agent.setPolicy({
    rules: ["Restart a media server that stopped"],
    acceptMode: options.allowed ? "auto" : "observe",
    autoContainers: options.list,
  });
  const accept = JSON.stringify({
    decision: "accept",
    matched: [policy.rules[0]!.id],
    reason: "a media server stopped",
  });
  fake.queueTurns([{ kind: "text", text: accept }]);
  return { app, d };
}

const decisionsOf = async (app: Awaited<ReturnType<typeof start>>["app"]) =>
  app.agent.listDecisions();

describe("auto, end to end on a Core with a Docker stand-in", () => {
  it("restarts a listed container that stopped, once, and leaves a receipt that says Core did it", async () => {
    const { app, d } = await start({ allowed: true, list: ["emby"] });
    d.set("emby", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await decisionsOf(app)).toHaveLength(1)
    );

    const [decision] = await decisionsOf(app);
    expect(decision).toMatchObject({
      outcome: "accept",
      wouldAccept: true,
      action: { kind: "restart", status: "succeeded", container: "emby" },
    });
    expect(d.restarted).toEqual(["id-emby"]);
    const receipt = await app.agent.getReceipt(decision!.action!.receiptId!);
    expect(receipt?.approval).toMatchObject({
      approved: true,
      source: "policy",
    });
    expect(receipt?.idempotencyKey).toBe(`auto:${decision!.id}`);
    await app.agent.quiesce();
  });

  it("only diagnoses a container that is not on the list, and restarts nothing", async () => {
    const { app, d } = await start({ allowed: true, list: ["emby"] });
    d.set("plex", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await decisionsOf(app)).toHaveLength(1)
    );
    const [decision] = await decisionsOf(app);
    expect(decision!.action?.kind).toBe("diagnose");
    expect(d.restarted).toEqual([]);
    await app.agent.quiesce();
  });

  it("restarts nothing when the host has not allowed auto, and still shows what it would have done", async () => {
    const { app, d } = await start({ allowed: false, list: ["emby"] });
    expect((await app.agent.getPolicy()).autoAvailable).toBe(false);
    // The host gate refused auto, so the policy stayed observe; a stored `auto` would act the same way.
    d.set("emby", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await decisionsOf(app)).toHaveLength(1)
    );
    const [decision] = await decisionsOf(app);
    expect(decision).toMatchObject({ outcome: "ignore", wouldAccept: true });
    expect(decision!.action).toBeUndefined();
    expect(d.restarted).toEqual([]);
    await app.agent.quiesce();
  });
});
