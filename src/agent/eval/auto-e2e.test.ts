import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerInfoProvider,
  ContainerState,
} from "../capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import type { ServiceAPIProvider } from "../capabilities/service-api.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

afterEach(() => vi.useRealTimers());

/**
 * A Docker stand-in. Containers are read through the container provider; a restart is a plain HTTP call
 * on a service connection that says it looks after containers, and the stand-in records each one.
 */
function docker(names: string[]) {
  const state = new Map<string, ContainerState>(
    names.map((n) => [n, "running"])
  );
  const restarted: string[] = [];
  const requests: string[] = [];
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
  } as unknown as ContainerInfoProvider;
  const service: ServiceAPIProvider = {
    id: "docker",
    resourceKinds: ["container"],
    catalog: async () => ({}),
    request: async ({ method, path }) => {
      requests.push(`${method} ${path}`);
      const restart = /^\/containers\/([^/]+)\/restart$/.exec(path);
      if (method === "POST" && restart) {
        restarted.push(restart[1]!);
        state.set(restart[1]!, "running");
      }
      return { ok: true, status: 204, body: "" };
    },
  };
  return {
    provider,
    service,
    restarted,
    requests,
    set: (n: string, s: ContainerState) => state.set(n, s),
  };
}

const RESTART_EMBY = {
  name: "service_write",
  args: { service: "docker", method: "POST", path: "/containers/emby/restart" },
  id: "call-restart",
};

const WORKER_DONE = [
  "Restarted emby and looked at it again: it is running.",
  "GOAL_STATUS: complete",
  "CHECKPOINT: emby restarted",
  "VERIFICATION: the restart request, then container state running",
  "REMAINING: none",
].join("\n");
const REVIEW_PASS =
  "VERDICT: pass\nEVIDENCE: the situation the event describes is resolved: the container tools show emby running after the restart\nREMAINING: none";

let lastFake: ReturnType<typeof createFakeRuntime> | undefined;

async function start(
  mode: "auto" | "observe",
  verdict: "accept" | "ignore" = "accept",
  turns?: Parameters<ReturnType<typeof createFakeRuntime>["queueTurns"]>[0]
) {
  vi.useFakeTimers();
  const d = docker(["emby", "nightly-backup"]);
  const fake = createFakeRuntime();
  lastFake = fake;
  const app = createThebeApp({
    runtime: fake.runtime,
    provider: d.provider,
    serviceAPIProviders: [d.service],
    sources: { containerHealth: true, intervalMs: 1000 },
  });
  await vi.advanceTimersByTimeAsync(0); // the Source's baseline
  const policy = await app.agent.setPolicy({
    rules: ["If a media server stops, it is worth restarting it."],
    acceptMode: mode,
  });
  const assessment = JSON.stringify({
    decision: verdict,
    matched: verdict === "accept" ? [policy.rules[0]!.id] : [],
    intent: "bring the emby container back up",
    reason: "a media server stopped",
  });
  // The assessment, then (if it is taken on) the executor's work and the reviewer's verdict.
  fake.queueTurns([
    { kind: "text", text: assessment },
    ...(turns ?? [
      {
        kind: "tools" as const,
        calls: [RESTART_EMBY],
      },
      { kind: "text" as const, text: WORKER_DONE },
      { kind: "text" as const, text: REVIEW_PASS },
    ]),
  ]);
  return { app, d };
}

const decisionsOf = (app: Awaited<ReturnType<typeof start>>["app"]) =>
  app.agent.listDecisions();

describe("auto, end to end on a Core with a Docker stand-in", () => {
  it("takes a stopped container on as a Ticket, and its executor restarts it under the Mandate", async () => {
    const { app, d } = await start("auto");
    d.set("emby", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await decisionsOf(app)).toHaveLength(1)
    );

    const [decision] = await decisionsOf(app);
    expect(decision).toMatchObject({ outcome: "accept", wouldAccept: true });
    expect(decision!.ticketId).toBeTruthy();
    expect(decision!.goalId).toBeTruthy();

    // The Ticket is inferred and by Eval; its Mandate names the policy, the rule and what it may touch.
    const tickets = await app.agent.listTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      id: decision!.ticketId,
      title: "bring the emby container back up",
      mandate: {
        strength: "inferred",
        decidedBy: "eval",
        evalId: decision!.evalId,
        policyVersion: decision!.policyVersion,
        matchedRuleIds: decision!.matchedRuleIds,
        scope: ["docker:write"],
        intent: "bring the emby container back up",
      },
      subscriptions: ["resource:container:emby"],
      links: { decisionId: decision!.id, legacyGoalId: decision!.goalId },
    });

    // The executor did the work: one restart, a plain call on the service connection, covered by the
    // Mandate (nobody was there to ask).
    await vi.waitFor(() => expect(d.restarted).toEqual(["emby"]));
    await vi.waitFor(() =>
      expect(app.agent.getGoal(decision!.goalId!)?.status).toBe("completed")
    );
    // Nothing else was restarted, and the same Eval made no second Ticket.
    expect(d.requests).toEqual(["POST /containers/emby/restart"]);
    expect(await app.agent.listTickets()).toHaveLength(1);
    await app.agent.quiesce();
  });

  it("makes no Ticket and restarts nothing in observe, and still shows what it would have done", async () => {
    const { app, d } = await start("observe");
    d.set("emby", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await decisionsOf(app)).toHaveLength(1)
    );
    const [decision] = await decisionsOf(app);
    expect(decision).toMatchObject({ outcome: "ignore", wouldAccept: true });
    expect(decision!.ticketId).toBeUndefined();
    expect(await app.agent.listTickets()).toEqual([]);
    expect(d.restarted).toEqual([]);
    await app.agent.quiesce();
  });

  it("makes no Ticket when the rules do not call for it", async () => {
    const { app, d } = await start("auto", "ignore");
    d.set("nightly-backup", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await decisionsOf(app)).toHaveLength(1)
    );
    const [decision] = await decisionsOf(app);
    expect(decision).toMatchObject({ outcome: "ignore", wouldAccept: false });
    expect(await app.agent.listTickets()).toEqual([]);
    expect(d.restarted).toEqual([]);
    await app.agent.quiesce();
  });

  it("does not cover what the Mandate does not: a delete, or a service the event is not about", async () => {
    const { app, d } = await start("auto", "accept", [
      {
        kind: "tools",
        calls: [
          {
            name: "service_write",
            args: {
              service: "docker",
              method: "DELETE",
              path: "/containers/emby",
            },
            id: "delete-emby",
          },
          {
            name: "service_write",
            args: {
              service: "radarr",
              method: "POST",
              path: "/api/v3/command",
            },
            id: "other-service",
          },
        ],
      },
      { kind: "text", text: WORKER_DONE },
      { kind: "text", text: REVIEW_PASS },
    ]);
    d.set("emby", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await decisionsOf(app)).toHaveLength(1)
    );
    const [decision] = await decisionsOf(app);
    // Nobody is there to approve them, so both are refused on the spot: the run goes on and finishes
    // instead of waiting for an answer, and neither reached a service.
    await vi.waitFor(() =>
      expect(app.agent.getGoal(decision!.goalId!)?.status).toBe("completed")
    );
    expect(d.requests).toEqual([]);
    await app.agent.quiesce();
  });

  it("does not let the reviewer change anything: it has the tools that change nothing", async () => {
    // The worker finishes without restarting; the reviewer then tries to, and has no such tool.
    const { app, d } = await start("auto", "accept", [
      { kind: "text", text: WORKER_DONE },
      {
        kind: "tools",
        calls: [{ ...RESTART_EMBY, id: "reviewer-restart" }],
      },
      { kind: "text", text: REVIEW_PASS },
    ]);
    d.set("emby", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await decisionsOf(app)).toHaveLength(1)
    );
    await vi.waitFor(() =>
      expect(
        lastFake!
          .inboundToolResults()
          .some((row) => row.toolName === "service_write")
      ).toBe(true)
    );
    const attempt = lastFake!
      .inboundToolResults()
      .find((row) => row.toolName === "service_write")!;
    expect(attempt.isError).toBe(true);
    expect(attempt.text).toContain("unknown tool");
    expect(d.restarted).toEqual([]);
    await app.agent.quiesce();
  });
});
