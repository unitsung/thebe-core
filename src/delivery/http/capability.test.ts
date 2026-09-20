import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

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

function app() {
  return createThebeApp({
    runtime: createFakeRuntime().runtime,
    provider: provider(),
  });
}

describe("capability product HTTP", () => {
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
    const res = await app().handler.handle(
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
    expect(["queued", "running", "succeeded", "failed"]).toContain(run.status);
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
