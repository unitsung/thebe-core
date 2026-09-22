import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { resetGoalLogStreamsForTests } from "./protocol/sse.ts";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("inspect not used");
    },
    getContainerLogs: async () => {
      throw new Error("logs not used");
    },
    getStatusSummary: async () => {
      throw new Error("summary not used");
    },
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const PI_LEAK = /assistantMessageEvent|@earendil|tools\/call|internalState|AgentSession/;

function completingTurns() {
  return [
    { kind: "text" as const, text: "I inspected the workspace and completed the checkpoint." },
    {
      kind: "text" as const,
      text: "VERDICT: pass\nEVIDENCE: pnpm test — all tests pass\nREMAINING: none",
    },
  ];
}

afterEach(() => {
  resetGoalLogStreamsForTests();
});

describe("Goal HTTP", () => {
  it("POST /v1/goals creates a session+goal and returns ProductGoal", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns(completingTurns());
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "Finish the refactor", criteria: ["tests pass"], maxIterations: 3 }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.id).toEqual(expect.any(String));
    expect(body.sessionId).toBe(body.id);
    expect(body.title).toBe("Finish the refactor");
    expect(body.status).toMatch(/queued|running|succeeded/);
    expect(body.controls).toEqual(
      expect.objectContaining({ pause: expect.any(Boolean), resume: expect.any(Boolean), stop: expect.any(Boolean) }),
    );
    expect(JSON.stringify(body)).not.toMatch(PI_LEAK);
    expect(body).not.toHaveProperty("thebeSessionId");
    expect(body).not.toHaveProperty("finalReport");
    await app.agent.waitGoal(String(body.id));
  });

  it("publishes a completed Goal report as a linked Artifact", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns(completingTurns());
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const created = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/goals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "Publish the verified result" }),
        }),
      ),
    );
    const id = String(created.id);

    await app.agent.waitGoal(id);

    const goal = await json(
      await app.handler.handle(new Request(`http://127.0.0.1:8787/v1/goals/${id}`)),
    );
    expect(goal.artifactId).toEqual(expect.any(String));

    const listed = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts?kind=report&sessionId=${id}`),
      ),
    );
    const artifacts = listed.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual(
      expect.objectContaining({
        artifactId: goal.artifactId,
        kind: "report",
        sessionId: id,
        contentType: "text/plain; charset=utf-8",
      }),
    );

    const content = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${goal.artifactId}/content`),
      ),
    );
    expect(content.content).toContain("VERDICT: pass");
    expect(JSON.stringify(content)).not.toMatch(PI_LEAK);
  });

  it("lists persisted goals after a new app process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-goal-http-"));
    const fake = createFakeRuntime();
    fake.queueTurns(completingTurns());
    const first = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const created = await json(
      await first.handler.handle(
        new Request("http://127.0.0.1:8787/v1/goals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "Persist this objective" }),
        }),
      ),
    );
    await first.agent.waitGoal(String(created.id));

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const listed = await json(
      await restarted.handler.handle(new Request("http://127.0.0.1:8787/v1/goals")),
    );
    const goals = listed.goals as Array<Record<string, unknown>>;
    expect(goals).toHaveLength(1);
    expect(goals[0]?.id).toBe(created.id);
    expect(goals[0]?.title).toBe("Persist this objective");
    expect(goals[0]?.status).toBe("succeeded");
    expect(goals[0]?.artifactId).toEqual(expect.any(String));
    expect(JSON.stringify(listed)).not.toMatch(PI_LEAK);

    const fetched = await json(
      await restarted.handler.handle(new Request(`http://127.0.0.1:8787/v1/goals/${created.id}`)),
    );
    expect(fetched.id).toBe(created.id);
    expect(fetched.artifactId).toBe(goals[0]?.artifactId);

    const artifacts = await json(
      await restarted.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts?sessionId=${created.id}`),
      ),
    );
    expect(artifacts.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: goals[0]?.artifactId,
          kind: "report",
          sessionId: created.id,
        }),
      ]),
    );
  });

  it("preserves Goal log history across a Core restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-goal-log-recovery-http-"));
    const fake = createFakeRuntime();
    fake.queueTurns(completingTurns());
    const first = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const created = await json(
      await first.handler.handle(
        new Request("http://127.0.0.1:8787/v1/goals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "Keep the progress history" }),
        }),
      ),
    );
    const id = String(created.id);
    await first.agent.waitGoal(id);

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const log = await json(
      await restarted.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/goals/${id}/log`),
      ),
    );
    const events = log.events as Array<Record<string, unknown>>;
    expect(events.some((event) => event.type === "goal_started")).toBe(true);
    expect(events.some((event) => event.type === "goal_completed")).toBe(true);
    expect(log.next).toEqual(expect.any(Number));
    expect(JSON.stringify(log)).not.toMatch(PI_LEAK);
    expect(
      events.every(
        (event) => !Object.prototype.hasOwnProperty.call(event, "run"),
      ),
    ).toBe(true);
  });

  it("records explicit paused recovery in the Goal log after a Core restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-goal-recovery-http-"));
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }]);
    const first = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const created = await json(
      await first.handler.handle(
        new Request("http://127.0.0.1:8787/v1/goals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "Recover this active objective" }),
        }),
      ),
    );
    const id = String(created.id);
    await vi.waitFor(() => {
      expect(first.agent.getGoal(id)?.activeSubagent?.status).toBe("running");
    });

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const recovered = await json(
      await restarted.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/goals/${id}`),
      ),
    );
    expect(recovered.status).toBe("paused");
    expect(recovered.phase).toBe("paused");

    const log = await json(
      await restarted.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/goals/${id}/log`),
      ),
    );
    const events = log.events as Array<Record<string, unknown>>;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "goal_status",
          status: "paused",
          phase: "paused",
          message: expect.stringContaining("Core restart"),
        }),
      ]),
    );

    await first.agent.stopGoal(id);
  });

  it("GET /v1/session/{id}/goal matches GET /v1/goals/{id}", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns(completingTurns());
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const created = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/goals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Same object" }),
        }),
      ),
    );
    const id = String(created.id);
    const [canonical, alias] = await Promise.all([
      json(await app.handler.handle(new Request(`http://127.0.0.1:8787/v1/goals/${id}`))),
      json(await app.handler.handle(new Request(`http://127.0.0.1:8787/v1/session/${id}/goal`))),
    ]);
    expect(alias).toEqual(canonical);
    expect(canonical.id).toBe(id);
    await app.agent.waitGoal(id);
  });

  it("rejects an empty goal body with 400 invalid_body", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "   " }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe("invalid_body");
  });

  it("returns 409 invalid_transition when pausing a goal that is not running", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns(completingTurns());
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const created = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/goals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "Already done" }),
        }),
      ),
    );
    await app.agent.waitGoal(String(created.id));
    const res = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/goals/${created.id}/pause`, { method: "POST" }),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("invalid_transition");
  });

  it("returns 404 for an unknown goal id", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/goals/missing-goal"),
    );
    expect(res.status).toBe(404);
  });

  it("GET log JSON returns product events, not raw Pi types", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns(completingTurns());
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const created = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/goals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "Log product events" }),
        }),
      ),
    );
    await app.agent.waitGoal(String(created.id));
    const res = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/goals/${created.id}/log`),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const events = body.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "goal_started")).toBe(true);
    expect(events.every((event) => event.goalId === created.id)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(PI_LEAK);
    expect(JSON.stringify(body)).not.toContain("assistantMessageEvent");
    for (const event of events) {
      expect(event).not.toHaveProperty("run");
    }
  });

  it("GET log with Accept text/event-stream returns SSE and cleans up", async () => {
    resetGoalLogStreamsForTests({ max: 1 });
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }]);
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const created = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/goals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "Stream progress" }),
        }),
      ),
    );
    const id = String(created.id);
    const firstAc = new AbortController();
    const first = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/goals/${id}/log`, {
        headers: { accept: "text/event-stream" },
        signal: firstAc.signal,
      }),
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    const reader = first.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain("event: goal_");
    expect(chunk).not.toMatch(PI_LEAK);

    const crowded = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${id}/goal/log?follow=true`),
    );
    expect(crowded.status).toBe(429);

    firstAc.abort();
    await reader.cancel();

    const secondAc = new AbortController();
    const second = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/goals/${id}/log?follow=true`, {
        signal: secondAc.signal,
      }),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toContain("text/event-stream");
    secondAc.abort();
    await second.body?.cancel();
    await app.agent.stopGoal(id);
  });
});
