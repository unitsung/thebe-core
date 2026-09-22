import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import {
  createCapabilityRunStore,
} from "../../agent/capabilities/runs.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import type { StrmRepairProvider } from "../../agent/capabilities/strm.ts";
import { resetCapabilityRunLogStreamsForTests } from "./protocol/sse.ts";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [
      {
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        status: "Up",
        created: 1,
      },
    ],
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 1,
      runningContainers: 1,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function app(options: { agentStoreDir?: string; now?: () => Date } = {}) {
  return createThebeApp({
    runtime: createFakeRuntime().runtime,
    provider: provider(),
    ...options,
  });
}

async function fetchRun(
  handler: ReturnType<typeof app>["handler"],
  runId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const fetched = await handler.handle(
      new Request(`http://127.0.0.1:8787/v1/capabilities/runs/${runId}`),
    );
    const run = await json(fetched);
    if (run.status === "succeeded" || run.status === "failed" || run.status === "interrupted") return run;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`capability run did not finish: ${runId}`);
}

afterEach(() => {
  resetCapabilityRunLogStreamsForTests();
});

describe("capability product HTTP", () => {
  it("exposes and invokes a provider-backed strm.repair capability", async () => {
    const calls: unknown[] = [];
    const strmRepairProvider: StrmRepairProvider = {
      service: "openlist",
      async repair(input) {
        calls.push(input);
        return {
          status: "repaired",
          summary: "STRM path repaired and verified.",
          target: "/Movies/Dune.mkv",
          verification: { media: "reachable" },
        };
      },
    };
    const created = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      strmRepairProvider,
    });

    const capabilities = await json(
      await created.handler.handle(
        new Request("http://127.0.0.1:8787/v1/capabilities"),
      ),
    );
    expect(capabilities.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "strm.repair",
          service: "openlist",
          category: "media",
          effect: "write",
          permission: "confirm",
          approval: "none",
          resourceKinds: ["strm"],
          execution: "either",
          background: true,
          destructive: true,
        }),
      ]),
    );

    const response = await created.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/strm.repair/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          arguments: { title: "Dune", itemId: "/Movies/Dune.strm" },
          resource: {
            kind: "strm",
            id: "openlist:/Movies/Dune.strm",
            provider: "openlist",
          },
          mode: "direct",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const direct = await json(response);
    expect(direct).toEqual(expect.objectContaining({
      type: "result",
      result: {
        status: "repaired",
        summary: "STRM path repaired and verified.",
        target: "/Movies/Dune.mkv",
        verification: { media: "reachable" },
      },
      artifactId: expect.any(String),
    }));
    const artifactId = String(direct.artifactId);
    const artifact = await json(
      await created.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${artifactId}`),
      ),
    );
    expect(artifact).toEqual(expect.objectContaining({
      artifactId,
      kind: "report",
      resource: {
        kind: "strm",
        id: "openlist:/Movies/Dune.strm",
      },
      contentType: "application/json",
    }));
    const content = await json(
      await created.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${artifactId}/content`),
      ),
    );
    expect(JSON.parse(content.content as string)).toEqual(expect.objectContaining({
      version: 1,
      capabilityId: "strm.repair",
      result: {
        status: "repaired",
        summary: "STRM path repaired and verified.",
        target: "/Movies/Dune.mkv",
        verification: { media: "reachable" },
      },
    }));
    expect(calls).toEqual([
      {
        arguments: { title: "Dune", itemId: "/Movies/Dune.strm" },
        resource: {
          kind: "strm",
          id: "openlist:/Movies/Dune.strm",
          provider: "openlist",
        },
      },
    ]);
  });

  it("runs provider-backed strm.repair in the background with its resource", async () => {
    const calls: unknown[] = [];
    const created = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      strmRepairProvider: {
        service: "openlist",
        async repair(input) {
          calls.push(input);
          return {
            status: "repaired",
            summary: "background repair complete",
          };
        },
      },
    });

    const response = await created.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/strm.repair/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "background",
          arguments: { title: "Dune" },
          resource: { kind: "strm", id: "strm-1", provider: "openlist" },
        }),
      }),
    );
    expect(response.status).toBe(202);
    const started = await json(response);
    const run = await fetchRun(created.handler, String(started.runId));
    expect(run).toEqual(
      expect.objectContaining({
        capabilityId: "strm.repair",
        status: "succeeded",
        resource: { kind: "strm", id: "strm-1", provider: "openlist" },
        result: { status: "repaired", summary: "background repair complete" },
      }),
    );
    expect(calls).toEqual([
      {
        arguments: { title: "Dune" },
        resource: { kind: "strm", id: "strm-1", provider: "openlist" },
      },
    ]);
  });

  it("rejects strm.repair for a non-STRM resource before calling the provider", async () => {
    let called = false;
    const created = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      strmRepairProvider: {
        service: "openlist",
        async repair() {
          called = true;
          return { status: "repaired", summary: "unexpected" };
        },
      },
    });

    const response = await created.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/strm.repair/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          arguments: { title: "Dune" },
          resource: { kind: "media_item", id: "movie-1" },
          mode: "direct",
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual(
      expect.objectContaining({ error: expect.stringContaining("resource.kind") }),
    );
    expect(called).toBe(false);
  });

  it("rejects strm.repair when the resource provider differs from the configured provider", async () => {
    let called = false;
    const created = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      strmRepairProvider: {
        service: "openlist",
        async repair() {
          called = true;
          return { status: "repaired", summary: "unexpected" };
        },
      },
    });

    const response = await created.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/strm.repair/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          arguments: { title: "Dune", itemId: "/Movies/Dune.strm" },
          resource: {
            kind: "strm",
            id: "emby:/Movies/Dune.strm",
            provider: "emby",
          },
          mode: "direct",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("resource.provider"),
      }),
    );
    expect(called).toBe(false);
  });

  it("GET /v1/capabilities includes product metadata for discovery", async () => {
    const res = await app().handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities"),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const capabilities = body.capabilities as Array<Record<string, unknown>>;
    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "container.list",
          category: "containers",
          permission: "read",
          source: "core",
          service: "arcane",
          resourceKinds: ["container"],
          execution: "direct",
          background: false,
        }),
        expect.objectContaining({
          id: "container.restart",
          category: "containers",
          permission: "confirm",
          approval: "required",
          effect: "write",
          resourceKinds: ["container"],
          execution: "direct",
          background: false,
          destructive: true,
        }),
        expect.objectContaining({
          id: "emby.libraries",
          category: "media",
          source: "core",
          service: "emby",
          resourceKinds: ["media_library"],
          execution: "direct",
          background: false,
        }),
        expect.objectContaining({
          id: "immich.assets",
          category: "media",
          source: "core",
          service: "immich",
          resourceKinds: ["photo"],
        }),
        expect.objectContaining({
          id: "diagnose_from_events",
          category: "diagnostics",
          execution: "direct",
          background: true,
        }),
      ]),
    );
  });

  it("POST /v1/capabilities/{id}/invoke returns a direct result through the Agent", async () => {
    const created = app();
    const res = await created.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/container.list/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          arguments: {},
          mode: "direct",
          resource: { kind: "container", provider: "arcane" },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.type).toBe("result");
    expect(body.result).toEqual([
      expect.objectContaining({ id: "abc123", name: "nginx" }),
    ]);
    expect(body.artifactId).toEqual(expect.any(String));
    const artifactId = String(body.artifactId);
    const artifact = await json(
      await created.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${artifactId}`),
      ),
    );
    expect(artifact).toEqual(expect.objectContaining({
      artifactId,
      kind: "report",
      title: "Capability report: container.list",
      contentType: "application/json",
    }));
  });

  it("rejects unapproved container.restart invoke and does not restart", async () => {
    let restarts = 0;
    const restarting: ContainerInfoProvider = {
      ...provider(),
      restartContainer: async () => {
        restarts += 1;
      },
    };
    const created = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: restarting,
    });
    const res = await created.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/container.restart/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: { id: "ctr-emby" } }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error).toMatch(/approval/i);
    expect(restarts).toBe(0);
  });

  it("POST invoke with mode=background returns a run id that can be fetched", async () => {
    const created = app();
    const res = await created.handler.handle(
      new Request(
        "http://127.0.0.1:8787/v1/capabilities/diagnose_from_events/invoke",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "background", arguments: { category: "all" } }),
        },
      ),
    );
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.type).toBe("run");
    expect(body.runId).toEqual(expect.any(String));
    const fetched = await created.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/capabilities/runs/${body.runId}`),
    );
    expect(fetched.status).toBe(200);
    const run = await json(fetched);
    expect(run.runId).toBe(body.runId);
    expect(run.capabilityId).toBe("diagnose_from_events");
    expect(["queued", "running", "succeeded", "failed", "interrupted"]).toContain(run.status);
  });

  it("streams capability run snapshots over the log SSE route", async () => {
    let releaseRepair!: () => void;
    const repairReady = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    const created = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      strmRepairProvider: {
        service: "openlist",
        async repair() {
          await repairReady;
          return { status: "repaired", summary: "stream complete" };
        },
      },
    });
    const started = await created.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/strm.repair/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "background",
          arguments: { title: "Dune" },
          resource: { kind: "strm", id: "strm-1", provider: "openlist" },
        }),
      }),
    );
    const startedBody = await json(started);
    const runId = String(startedBody.runId);
    const response = await created.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/capabilities/runs/${runId}/log`, {
        headers: { accept: "text/event-stream" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(initial).toContain("event: capability_update");
    expect(initial).toContain(`\"runId\":\"${runId}\"`);
    expect(initial).toContain(`\"status\":\"running\"`);

    releaseRepair();
    const completed = new TextDecoder().decode((await reader.read()).value);
    expect(completed).toContain("event: capability_update");
    expect(completed).toContain(`\"status\":\"succeeded\"`);
    await reader.cancel();
  });

  it("links a bounded report Artifact from a completed background run", async () => {
    const created = app();
    const started = await created.handler.handle(
      new Request(
        "http://127.0.0.1:8787/v1/capabilities/diagnose_from_events/invoke",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "background",
            arguments: { category: "all" },
            resource: { kind: "container", id: "ctr-emby" },
          }),
        },
      ),
    );
    const startedBody = await json(started);
    const run = await fetchRun(created.handler, String(startedBody.runId));

    expect(run.status).toBe("succeeded");
    expect(run.artifactId).toEqual(expect.any(String));
    const artifact = await json(
      await created.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/artifacts/${String(run.artifactId)}`,
        ),
      ),
    );
    expect(artifact).toEqual(
      expect.objectContaining({
        artifactId: run.artifactId,
        kind: "report",
        runId: run.runId,
        resource: { kind: "container", id: "ctr-emby" },
      }),
    );
  });

  it("links a redacted report Artifact from a failed background run", async () => {
    const created = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      strmRepairProvider: {
        service: "openlist",
        async repair() {
          throw new Error("provider failed: TOKEN=top-secret");
        },
      },
    });
    const started = await created.handler.handle(
      new Request(
        "http://127.0.0.1:8787/v1/capabilities/strm.repair/invoke",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "background",
            arguments: { title: "Dune" },
            resource: { kind: "strm", id: "strm-1", provider: "openlist" },
          }),
        },
      ),
    );
    const startedBody = await json(started);
    const run = await fetchRun(created.handler, String(startedBody.runId));

    expect(run).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "provider failed: TOKEN=***REDACTED***",
        artifactId: expect.any(String),
      }),
    );
    const artifactId = String(run.artifactId);
    const artifact = await json(
      await created.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${artifactId}`),
      ),
    );
    expect(artifact).toEqual(
      expect.objectContaining({
        artifactId,
        kind: "report",
        runId: run.runId,
        resource: { kind: "strm", id: "strm-1" },
      }),
    );
    const content = await json(
      await created.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${artifactId}/content`),
      ),
    );
    expect(JSON.parse(content.content as string)).toEqual({
      version: 1,
      runId: run.runId,
      capabilityId: "strm.repair",
      status: "failed",
      error: "provider failed: TOKEN=***REDACTED***",
    });
  });

  it("persists terminal runs and restores them through a new Agent instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-capability-runs-"));
    const first = app({ agentStoreDir: dir });
    const started = await first.handler.handle(
      new Request(
        "http://127.0.0.1:8787/v1/capabilities/diagnose_from_events/invoke",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "background",
            arguments: { category: "all" },
            resource: { kind: "container", id: "ctr-emby" },
          }),
        },
      ),
    );
    const body = await json(started);
    const runId = String(body.runId);
    const completed = await fetchRun(first.handler, runId);
    expect(completed.status).toBe("succeeded");
    expect(completed.resource).toEqual({ kind: "container", id: "ctr-emby" });

    const restarted = app({ agentStoreDir: dir });
    const restored = await restarted.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/capabilities/runs/${runId}`),
    );
    expect(restored.status).toBe(200);
    const restoredRun = await json(restored);
    expect(restoredRun).toEqual({
      ...completed,
      recovery: "restored",
    });

    const listed = await restarted.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/runs"),
    );
    expect(listed.status).toBe(200);
    expect(await json(listed)).toEqual({ runs: [restoredRun] });
  });

  it("recovers an in-flight run from an older Core instance as interrupted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-capability-runs-"));
    const store = createCapabilityRunStore({
      dir: join(dir, "capability-runs"),
      ownerId: "previous-core-instance",
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });
    await store.save({
      runId: "stale-run",
      capabilityId: "diagnose_from_events",
      status: "running",
      createdAt: "2026-09-20T23:59:00.000Z",
    });

    const restarted = app({
      agentStoreDir: dir,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });
    const recovered = await restarted.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/runs/stale-run"),
    );
    expect(recovered.status).toBe(200);
    const run = await json(recovered);
    expect(run.status).toBe("interrupted");
    expect(run.recovery).toBe("interrupted");
    expect(run.error).toBe("Capability run interrupted when Core restarted.");
    expect(run.finishedAt).toBe("2026-09-21T00:00:00.000Z");
  });

  it("normalizes legacy interruption failures into explicit recovery state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-capability-legacy-recovery-"));
    const store = createCapabilityRunStore({
      dir: join(dir, "capability-runs"),
      ownerId: "previous-core-instance",
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });
    await store.save({
      runId: "legacy-interrupted",
      capabilityId: "diagnose_from_events",
      status: "failed",
      createdAt: "2026-09-20T23:59:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
      finishedAt: "2026-09-21T00:00:00.000Z",
      error: "Capability run interrupted when Core restarted.",
    });

    const restarted = app({
      agentStoreDir: dir,
      now: () => new Date("2026-09-21T00:00:01.000Z"),
    });
    const recovered = await restarted.handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/runs/legacy-interrupted"),
    );
    expect(recovered.status).toBe(200);
    expect(await json(recovered)).toEqual(expect.objectContaining({
      status: "interrupted",
      recovery: "interrupted",
      error: "Capability run interrupted when Core restarted.",
    }));
  });

  it("returns 404 for an unknown capability", async () => {
    const res = await app().handler.handle(
      new Request("http://127.0.0.1:8787/v1/capabilities/not.a.tool/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: {} }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
