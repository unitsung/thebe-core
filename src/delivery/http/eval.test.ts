import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerInfoProvider,
  ContainerState,
} from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function docker(initial: ContainerState) {
  let state = initial;
  const provider = {
    listContainers: async () => [
      { id: "i", name: "emby", image: "x", state, status: state, created: 1 },
    ],
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
    set: (next: ContainerState) => {
      state = next;
    },
  };
}

function open(
  opts: {
    watch?: boolean;
    provider?: ContainerInfoProvider;
  } = {}
) {
  const fake = createFakeRuntime();
  const app = createThebeApp({
    runtime: fake.runtime,
    provider: opts.provider ?? docker("running").provider,
    ...(opts.watch
      ? { sources: { containerHealth: true, intervalMs: 1000 } }
      : {}),
  });
  const call = async (path: string, init?: RequestInit) => {
    const res = await app.handler.handle(
      new Request(`http://127.0.0.1:8787${path}`, {
        ...init,
        headers: { "content-type": "application/json" },
      })
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  };
  const put = (body: unknown) =>
    call("/v1/policy", { method: "PUT", body: JSON.stringify(body) });
  return { app, fake, call, put };
}

afterEach(() => vi.useRealTimers());

describe("policy over HTTP", () => {
  it("starts empty in observe and takes plain-language rules", async () => {
    const { call, put } = open();
    expect((await call("/v1/policy")).body).toMatchObject({
      rules: [],
      acceptMode: "observe",
    });
    const saved = await put({
      rules: ["Restart a media server that stopped"],
      model: { providerId: "p", modelId: "m" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.rules).toHaveLength(1);
    expect(saved.body.rules[0].id).toMatch(/^[a-f0-9]{12}$/);
    expect((await call("/v1/policy")).body).toEqual(saved.body);
  });

  it("takes auto like any mode, says which modes this Core has, and keeps what is left out", async () => {
    const { call, put } = open();
    expect((await call("/v1/policy")).body.modes).toEqual([
      "off",
      "observe",
      "auto",
    ]);
    const saved = await put({
      rules: ["Restart a media server that stopped"],
      acceptMode: "auto",
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      acceptMode: "auto",
      modes: ["off", "observe", "auto"],
    });
    expect((await call("/v1/policy")).body).toEqual(saved.body);
    // Going back to observe keeps the rules.
    const back = await put({ acceptMode: "observe" });
    expect(back.body).toMatchObject({ acceptMode: "observe" });
    expect(back.body.rules).toHaveLength(1);
  });

  it("refuses an unknown mode and other bad input with 400, and other methods with 405", async () => {
    const { call, put } = open();
    for (const body of [
      { acceptMode: "x" },
      { rules: "nope" },
      { rules: [""] },
      { model: { providerId: "p" } },
    ]) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe("invalid_policy");
    }
    expect((await call("/v1/policy", { method: "DELETE" })).status).toBe(405);
  });

  it("is refused while Core is quiesced for maintenance", async () => {
    const { app, put } = open();
    await app.agent.quiesce();
    expect((await put({ rules: ["x"] })).status).toBe(503);
  });
});

describe("decisions over HTTP", () => {
  it("starts empty, is read-only, and answers 404 for an unknown or malformed id", async () => {
    const { call } = open();
    expect((await call("/v1/decisions")).body).toEqual({ decisions: [] });
    expect(
      (await call("/v1/decisions", { method: "POST", body: "{}" })).status
    ).toBe(405);
    expect((await call("/v1/decisions/" + "0".repeat(32))).status).toBe(404);
    expect((await call("/v1/decisions/..%2Fx")).status).toBe(404);
  });

  it("lists capabilities for a Core that has them", async () => {
    expect((await open().call("/v1/health")).body.capabilities).toEqual([
      "tickets",
      "policy",
      "decisions",
    ]);
  });
});

describe("a container going down, end to end", () => {
  it("is weighed by the model and recorded as what Core WOULD have done, without acting", async () => {
    vi.useFakeTimers();
    const d = docker("running");
    const { app, fake, call, put } = open({
      watch: true,
      provider: d.provider,
    });
    const { body: policy } = await put({
      rules: ["Restart a media server that stopped"],
    });
    const ruleId = policy.rules[0].id as string;
    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [ruleId],
          reason: "emby stopped",
        }),
      },
    ]);

    await vi.advanceTimersByTimeAsync(0); // baseline
    d.set("exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect((await call("/v1/decisions")).body.decisions).toHaveLength(1);
    });

    const [decision] = (
      await call("/v1/decisions?thread=resource:container:emby")
    ).body.decisions;
    expect(decision).toMatchObject({
      outcome: "ignore",
      wouldAccept: true,
      matchedRuleIds: [ruleId],
      reason: "emby stopped",
      thread: "resource:container:emby",
    });
    expect((await call(`/v1/decisions/${decision.id}`)).body.id).toBe(
      decision.id
    );
    expect((await call("/v1/tickets")).body.tickets).toEqual([]); // observe makes no Ticket
    // The assessment session is not left behind in the person's session list.
    expect(
      (await app.agent.listSessions()).filter(
        (s) => s.labels?.purpose === "eval-assessment"
      )
    ).toEqual([]);
    await app.agent.quiesce();
  });

  it("asks no model when there are no rules, and says so in the Decision", async () => {
    vi.useFakeTimers();
    const d = docker("running");
    const { app, call } = open({ watch: true, provider: d.provider });
    await vi.advanceTimersByTimeAsync(0);
    d.set("exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect((await call("/v1/decisions")).body.decisions).toHaveLength(1);
    });
    expect((await call("/v1/decisions")).body.decisions[0]).toMatchObject({
      gate: true,
      unavailableReason: "no_rules",
    });
    await app.agent.quiesce();
  });
});
