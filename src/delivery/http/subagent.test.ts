import { describe, expect, it } from "vitest";
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
