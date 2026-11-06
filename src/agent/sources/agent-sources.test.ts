import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerInfoProvider,
  ContainerState,
} from "../capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { parseEvalMaxPerHour, parseSources } from "../../app/bootstrap.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function docker(state: ContainerState) {
  const calls = { list: 0 };
  let current = state;
  const provider = {
    listContainers: async () => {
      calls.list += 1;
      return [
        {
          id: "i",
          name: "emby",
          image: "x",
          state: current,
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
});

describe("THEBE_SOURCES", () => {
  it("means none when unset, and names what to watch otherwise", () => {
    expect(parseSources({})).toBeUndefined();
    expect(parseSources({ THEBE_SOURCES: " " })).toBeUndefined();
    expect(parseSources({ THEBE_SOURCES: "Container-Health" })).toEqual({
      containerHealth: true,
    });
    expect(parseSources({ THEBE_SOURCES: "nonsense" })).toEqual({
      containerHealth: false,
    });
    expect(
      parseSources({
        THEBE_SOURCES: "container-health",
        THEBE_SOURCE_INTERVAL_MS: "5000",
      })
    ).toEqual({ containerHealth: true, intervalMs: 5000 });
    expect(
      parseSources({
        THEBE_SOURCES: "container-health",
        THEBE_SOURCE_INTERVAL_MS: "5",
      })
    ).toEqual({ containerHealth: true });
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
