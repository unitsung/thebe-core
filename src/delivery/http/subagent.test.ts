import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("subagent/worker product HTTP", () => {
  it("lists builtin profiles without host file paths", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/subagents/profiles"),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const profiles = body.profiles as Array<Record<string, unknown>>;
    expect(profiles.map((item) => item.name)).toEqual(
      expect.arrayContaining(["diagnostics", "log-analyzer"]),
    );
    expect(profiles[0]).not.toHaveProperty("filePath");
    expect(profiles[0]).not.toHaveProperty("systemPrompt");
  });

  it("spawns, lists, inspects, observes, and cancels a worker without the parent transcript", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "parent-secret-transcript" },
      { kind: "hang" },
    ]);
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const created = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      ),
    );
    const parentSessionId = String(created.thebeSessionId);
    await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${parentSessionId}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "parent-secret-transcript" }),
      }),
    );

    const spawned = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/subagents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileName: "diagnostics",
          task: "inspect health",
          parentSessionId,
        }),
      }),
    );
    expect(spawned.status).toBe(201);
    const worker = await json(spawned);
    expect(worker.runId).toEqual(expect.any(String));
    expect(worker.parentSessionId).toBe(parentSessionId);
    expect(worker.profileName).toBe("diagnostics");
    expect(worker.task).toBe("inspect health");
    expect(["queued", "running"]).toContain(worker.status);
    expect(JSON.stringify(worker)).not.toContain("parent-secret-transcript");

    const listed = await json(
      await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/subagents?parentSessionId=${parentSessionId}`,
        ),
      ),
    );
    const items = listed.subagents as Array<Record<string, unknown>>;
    expect(items.some((item) => item.runId === worker.runId)).toBe(true);

    const got = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/subagents/${worker.runId}`),
      ),
    );
    expect(got.runId).toBe(worker.runId);
    expect(JSON.stringify(got)).not.toContain("parent-secret-transcript");

    const log = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/subagents/${worker.runId}/log`),
      ),
    );
    expect(Array.isArray(log.activity)).toBe(true);
    expect(JSON.stringify(log)).not.toContain("parent-secret-transcript");

    const cancelled = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/subagents/${worker.runId}/cancel`, {
        method: "POST",
      }),
    );
    expect(cancelled.status).toBe(200);
    const after = await json(cancelled);
    expect(after.status).toBe("cancelled");
  });

  it("publishes a completed Worker report as a linked Artifact", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "worker report evidence" }]);
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const created = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      ),
    );
    const parentSessionId = String(created.thebeSessionId);
    const spawned = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/subagents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileName: "diagnostics",
          task: "retain this report",
          parentSessionId,
        }),
      }),
    );
    const worker = await json(spawned);
    const runId = String(worker.runId);
    await app.agent.waitSubagent(runId);

    const detail = await json(
      await app.handler.handle(new Request(`http://127.0.0.1:8787/v1/subagents/${runId}`)),
    );
    expect(detail.artifactId).toEqual(expect.any(String));

    const listed = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts?kind=report&runId=${runId}`),
      ),
    );
    expect(listed.artifacts).toEqual([
      expect.objectContaining({
        artifactId: detail.artifactId,
        kind: "report",
        runId,
        sessionId: parentSessionId,
      }),
    ]);

    const content = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${detail.artifactId}/content`),
      ),
    );
    expect(content.content).toContain("worker report evidence");
  });

  it("lists persisted terminal workers after a Core restart without opening the parent session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-worker-http-"));
    const firstFake = createFakeRuntime();
    firstFake.queueTurns([{ kind: "text", text: "persisted worker result" }]);
    const first = createThebeApp({
      runtime: firstFake.runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const created = await json(
      await first.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      ),
    );
    const parentSessionId = String(created.thebeSessionId);
    const spawned = await first.handler.handle(
      new Request("http://127.0.0.1:8787/v1/subagents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileName: "diagnostics",
          task: "persist this worker",
          parentSessionId,
        }),
      }),
    );
    expect(spawned.status).toBe(201);
    const worker = await json(spawned);
    await first.agent.waitSubagent(String(worker.runId));

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const listed = await json(
      await restarted.handler.handle(
        new Request("http://127.0.0.1:8787/v1/subagents"),
      ),
    );
    const workers = listed.subagents as Array<Record<string, unknown>>;
    expect(workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: worker.runId,
          parentSessionId,
          status: "completed",
          result: "persisted worker result",
          artifactId: expect.any(String),
        }),
      ]),
    );
    const restoredWorker = workers.find((item) => item.runId === worker.runId);
    const artifacts = await json(
      await restarted.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts?runId=${worker.runId}`),
      ),
    );
    expect(artifacts.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: restoredWorker?.artifactId,
          kind: "report",
          runId: worker.runId,
          sessionId: parentSessionId,
        }),
      ]),
    );
  });

  it("marks a persisted active worker interrupted after a Core restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-worker-recovery-http-"));
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }]);
    const first = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const created = await json(
      await first.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      ),
    );
    const parentSessionId = String(created.thebeSessionId);
    const spawned = await first.handler.handle(
      new Request("http://127.0.0.1:8787/v1/subagents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileName: "diagnostics",
          task: "recover this active worker",
          parentSessionId,
        }),
      }),
    );
    const worker = await json(spawned);
    const runId = String(worker.runId);
    await vi.waitFor(() => {
      expect(first.agent.getSubagent(runId)?.status).toBe("running");
    });

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const listed = await json(
      await restarted.handler.handle(
        new Request("http://127.0.0.1:8787/v1/subagents"),
      ),
    );
    const workers = listed.subagents as Array<Record<string, unknown>>;
    expect(workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId,
          status: "interrupted",
          error: "Subagent run interrupted when Core restarted.",
          finishedAt: expect.any(String),
        }),
      ]),
    );

    await first.agent.cancelSubagent(runId, parentSessionId);
  });

  it("reads a persisted worker by id after a Core restart without listing first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-worker-detail-http-"));
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "worker detail result" }]);
    const first = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const created = await json(
      await first.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      ),
    );
    const parentSessionId = String(created.thebeSessionId);
    const spawned = await first.handler.handle(
      new Request("http://127.0.0.1:8787/v1/subagents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileName: "diagnostics",
          task: "persist this worker detail",
          parentSessionId,
        }),
      }),
    );
    const worker = await json(spawned);
    const runId = String(worker.runId);
    await first.agent.waitSubagent(runId);

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const detail = await restarted.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/subagents/${runId}`),
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toEqual(
      expect.objectContaining({
        runId,
        status: "completed",
        result: "worker detail result",
      }),
    );
  });

  it("returns 404 for an unknown worker", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/subagents/missing"),
    );
    expect(res.status).toBe(404);
  });
});
