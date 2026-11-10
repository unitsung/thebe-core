import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerHealth,
  ContainerInfoProvider,
  ContainerState,
} from "../capabilities/containers.ts";
import type {
  DownloadItem,
  DownloadProvider,
} from "../capabilities/pipeline.ts";
import { createThebeApp } from "../../app/create.ts";
import { parseEvalMaxPerHour, parseSources } from "../../app/bootstrap.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function docker(state: ContainerState, health?: ContainerHealth) {
  const calls = { list: 0 };
  let current = state;
  let currentHealth = health;
  const provider = {
    listContainers: async () => {
      calls.list += 1;
      return [
        {
          id: "i",
          name: "emby",
          image: "x",
          state: current,
          ...(currentHealth ? { health: currentHealth } : {}),
          status: current,
          created: 1,
        },
      ];
    },
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "",
    getStatusSummary: async () => ({
      totalContainers: 1,
      runningContainers: 1,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  } as unknown as ContainerInfoProvider;
  return {
    provider,
    calls,
    set: (next: ContainerState) => {
      current = next;
    },
    setHealth: (next: ContainerHealth) => {
      currentHealth = next;
    },
  };
}

function download(phase: DownloadItem["phase"]) {
  const calls = { list: 0 };
  let failure: Error | undefined;
  let current: DownloadItem = {
    hash: "a".repeat(40),
    id: "a".repeat(40),
    name: "Example",
    engine: "qbittorrent",
    phase,
    state: phase === "completed" ? "seeding" : "downloading",
    badges: [],
    capabilities: [],
    progress: phase === "completed" ? 1 : 0.5,
    ...(phase === "completed"
      ? { completedAt: "2026-11-06T10:01:00.000Z" }
      : {}),
  };
  const provider = {
    service: "downloads",
    add: async () => ({ submitted: 0 }),
    list: async () => {
      calls.list += 1;
      if (failure) throw failure;
      return [{ ...current }];
    },
    get: async (hash: string) =>
      current.hash === hash ? { ...current } : undefined,
  } as DownloadProvider;
  return {
    provider,
    calls,
    set(next: DownloadItem["phase"]) {
      current = {
        ...current,
        phase: next,
        state: next === "completed" ? "seeding" : "downloading",
        progress: next === "completed" ? 1 : 0.5,
      };
    },
    fail(error: Error = new Error("download engine unavailable")) {
      failure = error;
    },
    recover() {
      failure = undefined;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("watching sources", () => {
  it("is off unless asked: a Core given no sources reads no container state", async () => {
    vi.useFakeTimers();
    const d = docker("running");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: d.provider,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(d.calls.list).toBe(0);
    expect(await app.agent.listTriggers()).toEqual([]);
  });

  it("records a Trigger when a watched container goes down, and stops when quiesced", async () => {
    vi.useFakeTimers();
    const d = docker("running");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: d.provider,
      sources: { containerHealth: true, intervalMs: 1000 },
    });
    await vi.advanceTimersByTimeAsync(0); // baseline
    expect(await app.agent.listTriggers()).toEqual([]);

    d.set("exited");
    await vi.advanceTimersByTimeAsync(1000);
    const triggers = await app.agent.listTriggers({
      thread: "resource:container:emby",
    });
    expect(triggers.map((t) => t.kind)).toEqual(["container.went_down"]);

    await app.agent.quiesce();
    const reads = d.calls.list;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.calls.list).toBe(reads);
    await app.agent.unquiesce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.calls.list).toBeGreaterThan(reads);
    await app.agent.quiesce();
  });

  it("records a running container becoming unhealthy and recovering", async () => {
    vi.useFakeTimers();
    const d = docker("running", "healthy");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: d.provider,
      sources: { containerHealth: true, intervalMs: 1000 },
    });
    await vi.advanceTimersByTimeAsync(0);

    d.setHealth("unhealthy");
    await vi.advanceTimersByTimeAsync(1000);
    const thread = "resource:container:emby";
    expect(
      (await app.agent.listTriggers({ thread })).map((t) => t.kind)
    ).toEqual(["container.unhealthy"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(await app.agent.listTriggers({ thread })).toHaveLength(1);

    d.setHealth("healthy");
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      (await app.agent.listTriggers({ thread })).map((t) => t.kind)
    ).toEqual(["container.recovered", "container.unhealthy"]);
    await app.agent.quiesce();
  });

  it("weighs one recorded Trigger again after an explicit requeue", async () => {
    vi.useFakeTimers();
    const d = docker("running");
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: d.provider,
      sources: { containerHealth: true, intervalMs: 1000 },
    });
    const policy = await app.agent.setPolicy({
      rules: ["Diagnose a container that stopped"],
    });
    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [policy.rules[0]!.id],
          reason: "first assessment",
        }),
      },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    d.set("exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect(await app.agent.listDecisions()).toHaveLength(1);
    });
    const [trigger] = await app.agent.listTriggers();

    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "ignore",
          matched: [],
          reason: "looked again",
        }),
      },
    ]);
    await expect(app.agent.requeueTrigger(trigger!.id)).resolves.toMatchObject({
      queued: true,
      triggerId: trigger!.id,
    });
    await vi.waitFor(async () => {
      expect(await app.agent.listDecisions()).toHaveLength(2);
    });
    expect(
      (await app.agent.listDecisions()).find(
        (decision) => decision.requeueIds?.length
      )
    ).toMatchObject({
      reason: "looked again",
      requeueIds: [expect.stringMatching(/^[a-f0-9]{32}$/)],
    });
    await app.agent.quiesce();
  });

  it("records a download entering completed on its resource thread", async () => {
    vi.useFakeTimers();
    const d = download("completed");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: docker("running").provider,
      pipeline: { downloads: d.provider },
      sources: { downloadCompleted: true, intervalMs: 1000 },
    });
    await vi.advanceTimersByTimeAsync(0); // baseline: old completed downloads are history
    expect(await app.agent.listTriggers()).toEqual([]);

    d.set("downloading");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await app.agent.listTriggers()).toEqual([]);

    d.set("completed");
    await vi.advanceTimersByTimeAsync(1000);
    const thread = `resource:download:qbittorrent:${"a".repeat(40)}`;
    const triggers = await app.agent.listTriggers({ thread });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      source: "download-completed",
      kind: "download.completed",
      threads: [thread],
      resource: {
        kind: "download",
        id: `qbittorrent:${"a".repeat(40)}`,
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(await app.agent.listTriggers({ thread })).toHaveLength(1);
    await app.agent.quiesce();
  });

  it("reports consecutive Source failures in health and clears them on recovery", async () => {
    vi.useFakeTimers();
    const d = download("downloading");
    d.fail();
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: docker("running").provider,
      pipeline: { downloads: d.provider },
      sources: { downloadCompleted: true, intervalMs: 1000 },
    });
    const health = async () =>
      (await (
        await app.handler.handle(new Request("http://127.0.0.1:8787/v1/health"))
      ).json()) as {
        capabilities: string[];
        sources: Array<Record<string, unknown>>;
      };

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await health()).toMatchObject({
      capabilities: expect.arrayContaining(["sources"]),
      sources: [
        {
          id: "download-completed",
          state: "failing",
          consecutiveFailures: 2,
          lastError: "download engine unavailable",
        },
      ],
    });

    d.recover();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await health()).toMatchObject({
      sources: [
        {
          id: "download-completed",
          state: "healthy",
          consecutiveFailures: 0,
        },
      ],
    });
    const recovered = await health();
    expect(recovered.sources[0]).not.toHaveProperty("lastError");
    await app.agent.quiesce();
  });

  it("keeps a requested download Source visible when no engine is configured", async () => {
    vi.useFakeTimers();
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: docker("running").provider,
      sources: { downloadCompleted: true, intervalMs: 1000 },
    });
    await vi.advanceTimersByTimeAsync(0);
    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/health")
    );
    const body = (await response.json()) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(body.sources).toEqual([
      expect.objectContaining({
        id: "download-completed",
        state: "failing",
        consecutiveFailures: 1,
        lastError: "No download provider is configured",
      }),
    ]);
    await app.agent.quiesce();
  });
});

describe("THEBE_SOURCES", () => {
  it("means none when unset, and names what to watch otherwise", () => {
    expect(parseSources({})).toBeUndefined();
    expect(parseSources({ THEBE_SOURCES: " " })).toBeUndefined();
    expect(parseSources({ THEBE_SOURCES: "Container-Health" })).toEqual({
      containerHealth: true,
      downloadCompleted: false,
    });
    expect(parseSources({ THEBE_SOURCES: "nonsense" })).toEqual({
      containerHealth: false,
      downloadCompleted: false,
    });
    expect(
      parseSources({
        THEBE_SOURCES: "container-health",
        THEBE_SOURCE_INTERVAL_MS: "5000",
      })
    ).toEqual({
      containerHealth: true,
      downloadCompleted: false,
      intervalMs: 5000,
    });
    expect(
      parseSources({
        THEBE_SOURCES: "container-health",
        THEBE_SOURCE_INTERVAL_MS: "5",
      })
    ).toEqual({ containerHealth: true, downloadCompleted: false });
    expect(parseSources({ THEBE_SOURCES: "download-completed" })).toEqual({
      containerHealth: false,
      downloadCompleted: true,
    });
  });
});

describe("THEBE_EVAL_MAX_PER_HOUR", () => {
  it("keeps the default when unset or unreadable, and 0 turns the limit off", () => {
    expect(parseEvalMaxPerHour({})).toBeUndefined();
    expect(
      parseEvalMaxPerHour({ THEBE_EVAL_MAX_PER_HOUR: " " })
    ).toBeUndefined();
    expect(
      parseEvalMaxPerHour({ THEBE_EVAL_MAX_PER_HOUR: "many" })
    ).toBeUndefined();
    expect(
      parseEvalMaxPerHour({ THEBE_EVAL_MAX_PER_HOUR: "-5" })
    ).toBeUndefined();
    expect(
      parseEvalMaxPerHour({ THEBE_EVAL_MAX_PER_HOUR: "2.5" })
    ).toBeUndefined();
    expect(parseEvalMaxPerHour({ THEBE_EVAL_MAX_PER_HOUR: "120" })).toBe(120);
    expect(parseEvalMaxPerHour({ THEBE_EVAL_MAX_PER_HOUR: "0" })).toBe(0);
  });
});
