import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { resetWorkerLogStreamsForTests } from "./protocol/sse.ts";

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

const PI_LEAK =
  /assistantMessageEvent|@earendil|tools\/call|internalState|AgentSession/;

afterEach(() => {
  resetWorkerLogStreamsForTests();
});

describe("subagent/worker product HTTP", () => {
  it("allows an operator-defined worker to request a write through the parent approval flow", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "thebe-custom-worker-"));
    await mkdir(join(workspace, ".thebe", "agents"), { recursive: true });
    await writeFile(
      join(workspace, ".thebe", "agents", "custom-editor.md"),
      "---\nname: custom-editor\ndescription: Edit an explicitly requested file\ntools: [write]\nallowWrites: true\n---\nPerform the explicit task and report the result.\n"
    );
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [
          {
            name: "write",
            args: {
              path: join(workspace, "requested.txt"),
              content: "requested content",
            },
          },
        ],
      },
      { kind: "text", text: "approved worker result" },
    ]);
    // The external runtime requires write to be enabled before it can request approval.
    const runtime = {
      ...fake.runtime,
      createSession: async (
        options: Parameters<typeof fake.runtime.createSession>[0]
      ) => {
        const session = await fake.runtime.createSession(options);
        if (options.inMemory && !session.toolNames().includes("write")) {
          throw new Error("Worker runtime does not have write capability");
        }
        return session;
      },
    };
    const app = createThebeApp({
      runtime,
      provider: provider(),
      workspacePath: workspace,
    });
    const parent = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" })
      )
    );
    const worker = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/subagents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profileName: "custom-editor",
            task: "Create the requested file",
            parentSessionId: parent.thebeSessionId,
          }),
        })
      )
    );
    let permissionId = "";
    try {
      await vi.waitFor(async () => {
        const pending = await json(
          await app.handler.handle(
            new Request("http://127.0.0.1:8787/v1/permissions")
          )
        );
        const permissions = pending.permissions as Array<
          Record<string, unknown>
        >;
        expect(permissions).toHaveLength(1);
        expect(permissions[0]).toMatchObject({
          toolName: "write",
          sessionId: parent.thebeSessionId,
        });
        permissionId = String(permissions[0]!.id);
      });
      const resolved = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/permissions/${permissionId}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response: "allow" }),
          }
        )
      );
      expect(resolved.status).toBe(200);
      await app.agent.waitSubagent(String(worker.runId));
      const detail = await json(
        await app.handler.handle(
          new Request(`http://127.0.0.1:8787/v1/subagents/${worker.runId}`)
        )
      );
      expect(detail).toMatchObject({
        status: "completed",
        result: "approved worker result",
      });
    } finally {
      await app.agent.cancelSubagent(String(worker.runId));
    }
  });

  it("lists builtin profiles without host file paths", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/subagents/profiles")
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const profiles = body.profiles as Array<Record<string, unknown>>;
    expect(profiles.map((item) => item.name)).toEqual(
      expect.arrayContaining(["diagnostics", "log-analyzer"])
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
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" })
      )
    );
    const parentSessionId = String(created.thebeSessionId);
    await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${parentSessionId}/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "parent-secret-transcript" }),
        }
      )
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
      })
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
          `http://127.0.0.1:8787/v1/subagents?parentSessionId=${parentSessionId}`
        )
      )
    );
    const items = listed.subagents as Array<Record<string, unknown>>;
    expect(items.some((item) => item.runId === worker.runId)).toBe(true);

    const got = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/subagents/${worker.runId}`)
      )
    );
    expect(got.runId).toBe(worker.runId);
    expect(JSON.stringify(got)).not.toContain("parent-secret-transcript");

    const log = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/subagents/${worker.runId}/log`)
      )
    );
    expect(Array.isArray(log.activity)).toBe(true);
    expect(JSON.stringify(log)).not.toContain("parent-secret-transcript");

    const cancelled = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/subagents/${worker.runId}/cancel`, {
        method: "POST",
      })
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
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" })
      )
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
      })
    );
    const worker = await json(spawned);
    const runId = String(worker.runId);
    await app.agent.waitSubagent(runId);

    const detail = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/subagents/${runId}`)
      )
    );
    expect(detail.artifactId).toEqual(expect.any(String));

    const listed = await json(
      await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/artifacts?kind=report&runId=${runId}`
        )
      )
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
        new Request(
          `http://127.0.0.1:8787/v1/artifacts/${detail.artifactId}/content`
        )
      )
    );
    expect(content.content).toContain("worker report evidence");
  });

  it("streams sanitized Worker snapshots over the log SSE route", async () => {
    resetWorkerLogStreamsForTests({ max: 1 });
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }]);
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const created = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" })
      )
    );
    const parentSessionId = String(created.thebeSessionId);
    const spawned = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/subagents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileName: "diagnostics",
          task: "stream this worker",
          parentSessionId,
        }),
      })
    );
    const worker = await json(spawned);
    const runId = String(worker.runId);
    await vi.waitFor(() => {
      expect(app.agent.getSubagent(runId)?.status).toBe("running");
    });

    const abort = new AbortController();
    const response = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/subagents/${runId}/log`, {
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain("event: worker_update");
    expect(chunk).toContain(`"runId":"${runId}"`);
    expect(chunk).not.toMatch(PI_LEAK);

    const crowded = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/subagents/${runId}/log`, {
        headers: { accept: "text/event-stream" },
      })
    );
    expect(crowded.status).toBe(429);

    abort.abort();
    await reader.cancel();

    const second = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/subagents/${runId}/log`, {
        headers: { accept: "text/event-stream" },
      })
    );
    expect(second.status).toBe(200);
    await second.body?.cancel();
    await app.agent.cancelSubagent(runId, parentSessionId);
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
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" })
      )
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
      })
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
        new Request("http://127.0.0.1:8787/v1/subagents")
      )
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
      ])
    );
    const restoredWorker = workers.find((item) => item.runId === worker.runId);
    const artifacts = await json(
      await restarted.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts?runId=${worker.runId}`)
      )
    );
    expect(artifacts.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: restoredWorker?.artifactId,
          kind: "report",
          runId: worker.runId,
          sessionId: parentSessionId,
        }),
      ])
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
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" })
      )
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
      })
    );
    const worker = await json(spawned);
    const runId = String(worker.runId);
    expect(worker.status).toBe("running");

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const listed = await json(
      await restarted.handler.handle(
        new Request("http://127.0.0.1:8787/v1/subagents")
      )
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
      ])
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
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" })
      )
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
      })
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
      new Request(`http://127.0.0.1:8787/v1/subagents/${runId}`)
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toEqual(
      expect.objectContaining({
        runId,
        status: "completed",
        result: "worker detail result",
      })
    );
  });

  it("returns 404 for an unknown worker", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/subagents/missing")
    );
    expect(res.status).toBe(404);
  });
});
