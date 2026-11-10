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
    expect(
      (
        await call(`/v1/decisions/${"0".repeat(32)}/accept`, {
          method: "POST",
        })
      ).status
    ).toBe(404);
    expect((await call("/v1/decisions/..%2Fx")).status).toBe(404);
  });

  it("lists capabilities for a Core that has them", async () => {
    const { call } = open();
    expect((await call("/v1/health")).body.capabilities).toEqual([
      "tickets",
      "main-session",
      "policy",
      "decisions",
    ]);
    expect((await call("/openapi.json")).body.paths).toMatchObject({
      "/v1/decisions/{id}/accept": { post: expect.any(Object) },
      "/v1/decisions/{id}/attach": { post: expect.any(Object) },
      "/v1/decisions/{id}/dismiss": { post: expect.any(Object) },
    });
  });

  it("refuses Candidate acceptance while quiesced and on the wrong method", async () => {
    const { app, call } = open();
    expect((await call(`/v1/decisions/${"0".repeat(32)}/accept`)).status).toBe(
      405
    );
    expect((await call(`/v1/decisions/${"0".repeat(32)}/attach`)).status).toBe(
      405
    );
    expect((await call(`/v1/decisions/${"0".repeat(32)}/dismiss`)).status).toBe(
      405
    );
    await app.agent.quiesce();
    expect(
      (
        await call(`/v1/decisions/${"0".repeat(32)}/accept`, {
          method: "POST",
        })
      ).status
    ).toBe(503);
    expect(
      (
        await call(`/v1/decisions/${"0".repeat(32)}/attach`, {
          method: "POST",
          body: JSON.stringify({ ticketId: "1".repeat(32) }),
        })
      ).status
    ).toBe(503);
    expect(
      (
        await call(`/v1/decisions/${"0".repeat(32)}/dismiss`, {
          method: "POST",
          body: "{}",
        })
      ).status
    ).toBe(503);
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
          intent: "restart the emby container",
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
    const dismissed = await call(`/v1/decisions/${decision.id}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ reason: "The person already handled it." }),
    });
    expect(dismissed.status).toBe(201);
    expect(dismissed.body).toMatchObject({
      reused: false,
      decision: {
        id: decision.id,
        dismissed: true,
        dismissalReason: "The person already handled it.",
        outcome: "ignore",
        wouldAccept: true,
      },
    });
    expect((await call(`/v1/decisions/${decision.id}`)).body).toMatchObject({
      outcome: "ignore",
      dismissed: true,
    });
    expect((await call("/v1/decisions")).body.decisions).toHaveLength(1);
    expect((await call("/v1/decisions")).body.decisions[0].dismissed).toBe(
      true
    );
    const dismissedAgain = await call(`/v1/decisions/${decision.id}/dismiss`, {
      method: "POST",
      body: "{}",
    });
    expect(dismissedAgain.status).toBe(200);
    expect(dismissedAgain.body.reused).toBe(true);
    expect((await call("/v1/tickets")).body.tickets).toEqual([]); // observe makes no Ticket
    // The assessment session is not left behind in the person's session list.
    expect(
      (await app.agent.listSessions()).filter(
        (s) => s.labels?.purpose === "eval-assessment"
      )
    ).toEqual([]);
    await app.agent.quiesce();
  });

  it("accepts the observed candidate as one explicit Ticket, without rewriting the Decision", async () => {
    vi.useFakeTimers();
    const d = docker("running");
    const { app, fake, call, put } = open({
      watch: true,
      provider: d.provider,
    });
    const { body: policy } = await put({
      rules: ["Restart a media server that stopped"],
    });
    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [policy.rules[0]!.id],
          intent: "restart the emby container",
          reason: "emby stopped",
        }),
      },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    d.set("exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect((await call("/v1/decisions")).body.decisions).toHaveLength(1);
    });
    const [decision] = (await call("/v1/decisions")).body.decisions;

    const accepted = await call(`/v1/decisions/${decision.id}/accept`, {
      method: "POST",
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({
      decisionId: decision.id,
      candidate: false,
      reused: false,
      ticket: {
        title: "restart the emby container",
        mandate: {
          strength: "explicit",
          decidedBy: "direct",
          requester: "chat",
        },
        links: { decisionId: decision.id },
      },
    });
    const ticketId = accepted.body.ticket.id as string;
    const again = await call(`/v1/decisions/${decision.id}/accept`, {
      method: "POST",
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      ticket: { id: ticketId },
      reused: true,
    });
    expect((await call(`/v1/decisions/${decision.id}`)).body).toMatchObject({
      outcome: "ignore",
      wouldAccept: true,
      acceptedTicketId: ticketId,
    });
    expect((await call("/v1/tickets")).body.tickets).toHaveLength(1);
    const goalId = accepted.body.ticket.links.legacyGoalId as string;
    await app.agent.stopGoal(goalId);
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await app.agent.quiesce();
  });

  it("attaches a Decision to an explicitly named ended Ticket and resumes it without another Eval", async () => {
    vi.useFakeTimers();
    const d = docker("running");
    const { app, fake, call, put } = open({
      watch: true,
      provider: d.provider,
    });
    const { body: policy } = await put({
      rules: ["Restart a media server that stopped"],
    });

    fake.queueTurns([
      { kind: "text", text: "The task finished." },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: current state checked\nREMAINING: none",
      },
    ]);
    const delegated = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Keep the media task durable",
        idempotencyKey: "attach-decision-target",
        maxIterations: 1,
      }),
    });
    expect(delegated.status).toBe(201);
    const ticketId = delegated.body.ticket.id as string;
    const goalId = delegated.body.ticket.links.legacyGoalId as string;
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "completed",
    });

    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [policy.rules[0]!.id],
          intent: "restart the emby container",
          reason: "emby stopped",
        }),
      },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    d.set("exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect((await call("/v1/decisions")).body.decisions).toHaveLength(1);
    });
    const [decision] = (await call("/v1/decisions")).body.decisions;

    const attached = await call(`/v1/decisions/${decision.id}/attach`, {
      method: "POST",
      body: JSON.stringify({
        ticketId,
        note: "Use this failure as context for the remaining media work.",
      }),
    });
    expect(attached.status).toBe(201);
    expect(attached.body).toMatchObject({
      decisionId: decision.id,
      attachedTicketId: ticketId,
      reused: false,
      stage: "running",
      ticket: {
        id: ticketId,
        subscriptions: expect.arrayContaining(["resource:container:emby"]),
        inputs: [
          {
            triggerId: decision.triggerIds[0],
            note: "Use this failure as context for the remaining media work.",
          },
        ],
      },
    });
    expect((await call(`/v1/decisions/${decision.id}`)).body).toMatchObject({
      candidate: false,
      attachedTicketId: ticketId,
    });
    await expect(app.agent.listDecisions()).resolves.toHaveLength(1);

    const again = await call(`/v1/decisions/${decision.id}/attach`, {
      method: "POST",
      body: JSON.stringify({ ticketId }),
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      attachedTicketId: ticketId,
      reused: true,
    });
    expect(await app.agent.getTicket(ticketId)).toMatchObject({
      inputs: [expect.objectContaining({ triggerId: decision.triggerIds[0] })],
    });

    await call(`/v1/tickets/${ticketId}/stop`, { method: "POST" });
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "cancelled",
    });
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
