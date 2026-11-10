import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const inspections: string[] = [];
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
    inspectContainer: async (id: string) => {
      inspections.push(id);
      return {
        id,
        name: id.slice(3),
        image: "img",
        state: state.get(id.slice(3)) ?? "running",
        config: {},
      };
    },
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
    inspections,
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
  const auditDir = await mkdtemp(join(tmpdir(), "auto-audit-"));
  const d = docker(["emby", "nightly-backup"]);
  const fake = createFakeRuntime();
  const pushes: Array<Record<string, unknown>> = [];
  lastFake = fake;
  const app = createThebeApp({
    runtime: fake.runtime,
    provider: d.provider,
    serviceAPIProviders: [d.service],
    auditPath: join(auditDir, "audit.jsonl"),
    agentStoreDir: auditDir,
    sources: { containerHealth: true, intervalMs: 1000 },
    pushRelayUrl: "https://relay.example",
    pushFetch: (async (_url: string, init: RequestInit) => {
      pushes.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  await app.handler.handle(
    new Request("http://127.0.0.1:8787/v1/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "t1",
        platform: "ios",
        relayDeviceId: "relay-1",
        categories: ["thebe.activity"],
      }),
    })
  );
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
  return { app, d, fake, pushes };
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
    // The person can read afterwards what it did: there is no restart receipt, so the audit record says it.
    await vi.waitFor(async () => {
      const audited = (await app.agent.listAudit({ method: "service_write" }))
        .entries;
      expect(audited).toHaveLength(1);
      expect(audited[0]!.summary).toContain("/containers/emby/restart");
    });
    await vi.waitFor(() =>
      expect(app.agent.getGoal(decision!.goalId!)?.status).toBe("completed")
    );
    // Nothing else was restarted, and the same Eval made no second Ticket.
    expect(d.requests).toEqual(["POST /containers/emby/restart"]);
    expect(await app.agent.listTickets()).toHaveLength(1);
    await app.agent.quiesce();
  });

  it("refuses to resume an Eval Ticket after its Policy rule is removed, audits it, and resumes after repair", async () => {
    const { app, d, fake } = await start("auto", "accept", [{ kind: "hang" }]);
    d.set("emby", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await decisionsOf(app)).toHaveLength(1)
    );

    const [decision] = await decisionsOf(app);
    const goalId = decision!.goalId!;
    await vi.waitFor(() =>
      expect(app.agent.getGoal(goalId)?.activeSubagent?.status).toBe("running")
    );
    await app.agent.pauseGoal(goalId);
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "paused",
    });
    const subagentsBefore = await app.agent.listSubagents(goalId);

    await app.agent.setPolicy({ rules: [] });
    const response = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/goals/${goalId}/resume`, {
        method: "POST",
      })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "ticket_mandate_invalid",
      error: expect.stringContaining("matched rule"),
    });
    expect(app.agent.getGoal(goalId)?.status).toBe("paused");
    expect(await app.agent.listSubagents(goalId)).toHaveLength(
      subagentsBefore.length
    );
    expect(
      (
        await app.agent.listAudit({
          method: "ticket.mandate_revalidate",
          sessionId: goalId,
        })
      ).entries
    ).toEqual([
      expect.objectContaining({
        result: "denied",
        source: "ticket",
        summary: expect.stringContaining("matched rule"),
      }),
    ]);

    await app.agent.setPolicy({
      rules: ["If a media server stops, it is worth restarting it."],
    });
    fake.queueTurns([
      { kind: "text", text: WORKER_DONE },
      { kind: "text", text: REVIEW_PASS },
    ]);
    await app.agent.resumeGoal(goalId);
    await vi.waitFor(() =>
      expect(app.agent.getGoal(goalId)?.status).toBe("completed")
    );
    expect(await app.agent.listSubagents(goalId)).toHaveLength(
      subagentsBefore.length + 2
    );
    await app.agent.quiesce();
  });

  it("revalidates an Eval Ticket's Mandate before retrying blocked work", async () => {
    const { app, d, fake } = await start("auto", "accept", [
      {
        kind: "tools",
        calls: [
          {
            name: "goal_report",
            args: {
              state: "blocked",
              blocker: "The Docker connection needs repair",
            },
          },
        ],
      },
      { kind: "text", text: "Blocked until Docker is reachable." },
    ]);
    d.set("emby", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await decisionsOf(app)).toHaveLength(1)
    );

    const [decision] = await decisionsOf(app);
    const goalId = decision!.goalId!;
    const ticketId = decision!.ticketId!;
    await vi.waitFor(() =>
      expect(app.agent.getGoal(goalId)).toMatchObject({
        status: "failed",
        blocked: true,
      })
    );

    await app.agent.setPolicy({ rules: [] });
    const denied = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/tickets/${ticketId}/retry`, {
        method: "POST",
      })
    );
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      code: "ticket_mandate_invalid",
      error: expect.stringContaining("matched rule"),
    });
    expect(app.agent.getGoal(goalId)).toMatchObject({
      status: "failed",
      blocked: true,
    });
    expect(
      (
        await app.agent.listAudit({
          method: "ticket.mandate_revalidate",
          sessionId: goalId,
        })
      ).entries
    ).toEqual([
      expect.objectContaining({
        result: "denied",
        source: "ticket",
        summary: expect.stringContaining("matched rule"),
      }),
    ]);

    await app.agent.setPolicy({
      rules: ["If a media server stops, it is worth restarting it."],
    });
    fake.queueTurns([
      { kind: "text", text: WORKER_DONE },
      { kind: "text", text: REVIEW_PASS },
    ]);
    const retried = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/tickets/${ticketId}/retry`, {
        method: "POST",
      })
    );
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      ticket: { id: ticketId },
      stage: "running",
      goal: { id: goalId, status: "running" },
    });
    await vi.waitFor(() =>
      expect(app.agent.getGoal(goalId)?.status).toBe("completed")
    );
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
    expect(d.inspections).toContain("emby");
    expect(await app.agent.listArtifacts({ kind: "diagnosis" })).toEqual([]);
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

  it.each([
    {
      name: "a service the event is not about",
      call: {
        name: "service_write",
        args: {
          service: "radarr",
          method: "POST",
          path: "/api/v3/command",
        },
        id: "other-service",
      },
      detail: "service_write acts on radarr, outside this Ticket's Mandate.",
    },
    {
      name: "an irreversible delete",
      call: {
        name: "service_write",
        args: {
          service: "docker",
          method: "DELETE",
          path: "/containers/emby",
        },
        id: "delete-emby",
      },
      detail:
        "service_write sends an HTTP DELETE to the service, so this Ticket's Mandate does not authorize it.",
    },
  ])(
    "blocks at once on $name, without asking the reviewer to accept the worker's claim",
    async ({ call, detail }) => {
      const { app, d, pushes } = await start("auto", "accept", [
        {
          kind: "tools",
          calls: [call],
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
      await vi.waitFor(() =>
        expect(app.agent.getGoal(decision!.goalId!)).toMatchObject({
          status: "failed",
          blocked: true,
          error: detail,
        })
      );
      const goal = app.agent.getGoal(decision!.goalId!)!;
      expect(goal.subagentRunIds).toHaveLength(1);
      expect(d.requests).toEqual([]);
      await vi.waitFor(() => expect(pushes).toHaveLength(1));
      expect(pushes[0]).toMatchObject({
        relayDeviceId: "relay-1",
        category: "thebe.activity",
        body: `A task is blocked and needs you: ${detail}`,
        deepLink: `thebe://goal/${encodeURIComponent(goal.thebeSessionId)}`,
        ticket: decision!.ticketId,
        seq: 1,
      });
      const activity = await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/activity/${goal.thebeSessionId}`)
      );
      expect(activity.status).toBe(200);
      expect(await activity.json()).toMatchObject({
        type: "goal",
        stage: "person",
        reason: "blocked",
        goal: {
          error: { code: "goal_blocked", message: detail },
        },
      });
      await app.agent.quiesce();
    }
  );

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
