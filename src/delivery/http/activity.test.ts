import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function provider(): ContainerInfoProvider {
  let state = "exited";
  return {
    listContainers: async () => [],
    inspectContainer: async (id) => ({
      id,
      name: "emby",
      image: "emby/embyserver:4.8",
      state,
      config: {},
    }),
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 1,
      runningContainers: state === "running" ? 1 : 0,
      pausedContainers: 0,
      exitedContainers: state === "exited" ? 1 : 0,
      lastUpdated: 1,
    }),
    restartContainer: async () => {
      state = "running";
    },
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function postAction(
  handler: { handle(request: Request): Promise<Response> },
  extra: Record<string, unknown> = {},
) {
  return handler.handle(
    new Request("http://127.0.0.1:8787/v1/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actionId: "container.restart",
        resource: { kind: "container", id: "ctr-emby", name: "emby", provider: "arcane" },
        approval: { approved: true, approvedAt: "2026-09-17T00:00:00Z", client: "ios" },
        idempotencyKey: "act-1",
        ...extra,
      }),
    }),
  );
}

describe("GET /v1/activity", () => {
  it("lists persisted records and reloads them from disk after a new app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-agent-store-"));
    const first = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const created = await json(await postAction(first.handler));
    expect(created.receiptId).toEqual(expect.any(String));

    const listed = await json(
      await first.handler.handle(new Request("http://127.0.0.1:8787/v1/activity")),
    );
    const activities = listed.activities as Array<Record<string, unknown>>;
    expect(activities).toHaveLength(1);
    expect(activities[0]).toEqual(
      expect.objectContaining({
        id: created.receiptId,
        kind: "container.restart",
        status: "succeeded",
        receiptId: created.receiptId,
      }),
    );

    const one = await first.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/activity/${created.receiptId}`),
    );
    expect(one.status).toBe(200);

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const after = await json(
      await restarted.handler.handle(new Request("http://127.0.0.1:8787/v1/activity")),
    );
    expect((after.activities as unknown[]).length).toBe(1);
    expect((after.activities as Array<Record<string, unknown>>)[0]?.id).toBe(created.receiptId);

    const dup = await json(await postAction(restarted.handler));
    expect(dup.receiptId).toBe(created.receiptId);
    const listedAgain = await json(
      await restarted.handler.handle(new Request("http://127.0.0.1:8787/v1/activity")),
    );
    expect((listedAgain.activities as unknown[]).length).toBe(1);
  });

  it("records rejected actions", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionId: "container.restart",
          resource: { kind: "container", id: "ctr-emby", provider: "arcane" },
          idempotencyKey: "deny",
        }),
      }),
    );
    const listed = await json(
      await app.handler.handle(new Request("http://127.0.0.1:8787/v1/activity")),
    );
    expect((listed.activities as Array<Record<string, unknown>>)[0]?.status).toBe("rejected");
  });

  it("returns 503 when the agent is not wired", async () => {
    const { createThebeHttpHandler } = await import("./handler.ts");
    const handler = createThebeHttpHandler({ version: "0.1.0" });
    const res = await handler.handle(new Request("http://127.0.0.1:8787/v1/activity"));
    expect(res.status).toBe(503);
  });

  it("returns an empty list when nothing has run", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(new Request("http://127.0.0.1:8787/v1/activity"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ activities: [] });
  });
});
