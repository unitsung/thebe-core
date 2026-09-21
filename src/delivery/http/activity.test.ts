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
  it("includes completed capability runs as typed Activity items", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const started = await app.handler.handle(
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
    expect(started.status).toBe(202);
    const startedBody = await json(started);
    const runId = String(startedBody.runId);

    let run: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/capabilities/runs/${runId}`),
      );
      run = await json(response);
      if (run.status === "succeeded" || run.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(run?.status).toBe("succeeded");

    const listed = await json(
      await app.handler.handle(new Request("http://127.0.0.1:8787/v1/activity")),
    );
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run",
          id: runId,
          group: "recent",
          updatedAt: expect.any(String),
          run: expect.objectContaining({
            runId,
            capabilityId: "diagnose_from_events",
            status: "succeeded",
            resource: { kind: "container", id: "ctr-emby" },
          }),
        }),
      ]),
    );

    const detail = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/activity/${runId}`),
    );
    expect(detail.status).toBe(200);
    expect(await json(detail)).toEqual(
      expect.objectContaining({
        type: "run",
        id: runId,
        run: expect.objectContaining({ runId }),
      }),
    );
  });

  it("documents run items in the Activity OpenAPI contract", async () => {
    const { createThebeHttpHandler } = await import("./handler.ts");
    const response = await createThebeHttpHandler({ version: "0.1.0" }).handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const document = (await response.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const activityGet = document.paths["/v1/activity"]?.get;
    expect(activityGet?.responses).toEqual(
      expect.objectContaining({
        "200": expect.objectContaining({
          content: expect.objectContaining({
            "application/json": expect.objectContaining({
              schema: { $ref: "#/components/schemas/ActivityList" },
            }),
          }),
        }),
      }),
    );
    expect(document.components.schemas).toEqual(
      expect.objectContaining({
        ActivityItem: expect.objectContaining({
          oneOf: expect.arrayContaining([
            { $ref: "#/components/schemas/ActivityRunItem" },
          ]),
        }),
        ActivityRunItem: expect.objectContaining({
          properties: expect.objectContaining({
            run: { $ref: "#/components/schemas/CapabilityRun" },
          }),
        }),
        ActivityList: expect.any(Object),
      }),
    );
  });

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
    const items = listed.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        type: "receipt",
        id: created.receiptId,
        group: "recent",
      }),
    );
    expect((items[0]?.receipt as Record<string, unknown>).status).toBe("succeeded");

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
    expect((after.items as unknown[]).length).toBe(1);
    expect((after.items as Array<Record<string, unknown>>)[0]?.id).toBe(created.receiptId);

    const dup = await json(await postAction(restarted.handler));
    expect(dup.receiptId).toBe(created.receiptId);
    const listedAgain = await json(
      await restarted.handler.handle(new Request("http://127.0.0.1:8787/v1/activity")),
    );
    expect((listedAgain.items as unknown[]).length).toBe(1);
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
    expect(
      ((listed.items as Array<Record<string, unknown>>)[0]?.receipt as Record<string, unknown>)
        ?.status,
    ).toBe("rejected");
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
    expect(await json(res)).toEqual({ items: [] });
  });

  it("mints one approval from diagnosis and mutates it into a receipt", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const diagnosed = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/diagnosis", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            resource: { kind: "container", id: "ctr-emby", name: "emby", provider: "arcane" },
          }),
        }),
      ),
    );
    expect(diagnosed.runId).toEqual(expect.any(String));
    expect(diagnosed.approvalId).toEqual(expect.any(String));
    expect(diagnosed.approvalId).not.toBe(diagnosed.runId);
    const pending = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/activity?group=needs_approval"),
      ),
    );
    const pendingRows = pending.items as Array<Record<string, unknown>>;
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]?.type).toBe("approval");
    expect(pendingRows[0]?.id).toBe(diagnosed.approvalId);
    expect(
      (pendingRows[0]?.approval as Record<string, unknown>).diagnosisRunId,
    ).toBe(diagnosed.runId);

    await postAction(app.handler, { diagnosisRunId: diagnosed.runId, idempotencyKey: "from-diag" });
    const after = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/activity?group=needs_approval"),
      ),
    );
    expect(after.items).toEqual([]);
    const recent = await json(
      await app.handler.handle(new Request("http://127.0.0.1:8787/v1/activity?group=recent")),
    );
    const recentRows = recent.items as Array<Record<string, unknown>>;
    expect(recentRows).toHaveLength(1);
    expect(recentRows[0]?.type).toBe("receipt");
    expect(recentRows[0]?.id).toBe(diagnosed.approvalId);
  });

  it("denies a pending approval and removes it from activity", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const diagnosed = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/diagnosis", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            resource: { kind: "container", id: "ctr-emby", name: "emby", provider: "arcane" },
          }),
        }),
      ),
    );
    const denied = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/activity/${diagnosed.approvalId}/deny`, {
        method: "POST",
      }),
    );
    expect(denied.status).toBe(200);
    const listed = await json(
      await app.handler.handle(new Request("http://127.0.0.1:8787/v1/activity")),
    );
    expect(listed.items).toEqual([]);
  });
});
