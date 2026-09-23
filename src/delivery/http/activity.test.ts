import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function provider(initialState: "exited" | "running" = "exited"): ContainerInfoProvider {
  let state = initialState;
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
  it("reads a persisted Goal by Activity id after Core recreation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-activity-goal-"));
    const firstRuntime = createFakeRuntime();
    firstRuntime.queueTurns([
      { kind: "text", text: "I inspected the workspace and completed the checkpoint." },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: persisted goal\nREMAINING: none",
      },
    ]);
    const first = createThebeApp({
      runtime: firstRuntime.runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const session = await first.agent.createSession({ title: "activity goal" });
    await first.agent.startGoal({
      thebeSessionId: session.thebeSessionId,
      goal: "Persist this Activity Goal",
    });
    await first.agent.waitGoal(session.thebeSessionId);

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const response = await restarted.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/activity/${session.thebeSessionId}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        type: "goal",
        id: session.thebeSessionId,
        goal: expect.objectContaining({
          id: session.thebeSessionId,
          title: "Persist this Activity Goal",
          status: "succeeded",
        }),
      }),
    );
  });

  it("includes completed workers as typed Activity items", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "worker result" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
    });
    const session = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      ),
    );
    const parentSessionId = String(session.thebeSessionId);
    const spawned = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/subagents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profileName: "diagnostics",
            task: "inspect health",
            parentSessionId,
          }),
        }),
      ),
    );
    const runId = String(spawned.runId);
    await app.agent.waitSubagent(runId);

    const listed = await json(
      await app.handler.handle(new Request("http://127.0.0.1:8787/v1/activity")),
    );
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "worker",
          id: runId,
          group: "recent",
          updatedAt: expect.any(String),
          worker: expect.objectContaining({
            runId,
            parentSessionId,
            task: "inspect health",
            status: "completed",
          }),
        }),
      ]),
    );
  });

  it("includes runtime background tasks as session-linked Activity items", async () => {
    const fake = createFakeRuntime();
    const dir = await mkdtemp(join(tmpdir(), "thebe-activity-task-"));
    let resumeCalls = 0;
    const runtime = {
      ...fake.runtime,
      async resumeSession(
        runtimeSessionId: string,
        create: Parameters<typeof fake.runtime.resumeSession>[1],
      ) {
        resumeCalls += 1;
        return fake.runtime.resumeSession(runtimeSessionId, create);
      },
      async listBackgroundTasksForSession(runtimeSessionId: string) {
        return fake.snapshot(runtimeSessionId).backgroundTasks;
      },
    };
    const first = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const session = await first.agent.createSession({ title: "task owner" });
    fake.snapshot(session.runtimeSessionId).backgroundTasks = [
      {
        id: "task-1",
        name: "dev server",
        pid: 4242,
        port: 3000,
        status: "running",
        startedAt: "2026-09-21T00:00:01.000Z",
      },
    ];

    const app = createThebeApp({
      runtime,
      provider: provider(),
      agentStoreDir: dir,
    });

    const activity = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/activity?source=background_task"),
      ),
    );
    const activityId = `${session.thebeSessionId}:task-1`;
    expect(activity.items).toEqual([
      expect.objectContaining({
        type: "background_task",
        id: activityId,
        group: "running",
        task: expect.objectContaining({
          id: "task-1",
          sessionId: session.thebeSessionId,
          name: "dev server",
          status: "running",
          startedAt: "2026-09-21T00:00:01.000Z",
          updatedAt: "2026-09-21T00:00:01.000Z",
        }),
      }),
    ]);
    expect(resumeCalls).toBe(0);

    const detail = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/activity/${encodeURIComponent(activityId)}`),
    );
    expect(detail.status).toBe(200);
    expect(await json(detail)).toEqual(
      expect.objectContaining({ type: "background_task", id: activityId }),
    );
  });

  it("includes provider-native background tasks and routes provider controls", async () => {
    const stopCalls: string[] = [];
    let stopAllCalls = 0;
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      backgroundTaskProviders: [
        {
          service: "openlist",
          async list() {
            return [
              {
                id: "copy:task-1",
                kind: "copy",
                name: "OpenList copy",
                status: "running" as const,
                startedAt: "2026-09-22T01:00:00Z",
                updatedAt: "2026-09-22T01:00:00Z",
              },
            ];
          },
          async stop(taskId: string) {
            stopCalls.push(taskId);
          },
          async stopAll() {
            stopAllCalls += 1;
          },
        },
      ],
    });

    const activity = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/activity?source=background_task"),
      ),
    );
    const activityId = "provider-openlist:copy:task-1";
    expect(activity.items).toEqual([
      expect.objectContaining({
        type: "background_task",
        id: activityId,
        group: "running",
        task: expect.objectContaining({
          id: "copy:task-1",
          sessionId: "provider-openlist",
          provider: "openlist",
          kind: "copy",
          name: "OpenList copy",
        }),
      }),
    ]);

    const detail = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/activity/${activityId}`),
    );
    expect(detail.status).toBe(200);
    expect(await json(detail)).toEqual(
      expect.objectContaining({ type: "background_task", id: activityId }),
    );

    const sessionTasks = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session/provider-openlist/background-task"),
    );
    expect(await json(sessionTasks)).toEqual({
      tasks: [expect.objectContaining({ id: "copy:task-1", status: "running" })],
    });

    const stopped = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${encodeURIComponent("provider-openlist")}/background-task/${encodeURIComponent("copy:task-1")}/stop`,
        { method: "POST" },
      ),
    );
    expect(stopped.status).toBe(200);
    expect(stopCalls).toEqual(["copy:task-1"]);

    const stoppedAll = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${encodeURIComponent("provider-openlist")}/background-task/stop-all`,
        { method: "POST" },
      ),
    );
    expect(stoppedAll.status).toBe(200);
    expect(stopAllCalls).toBe(1);
  });

  it("reads a worker Activity detail without the parent transcript", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "parent answer" },
      { kind: "text", text: "worker result" },
    ]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
    });
    const session = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      ),
    );
    const parentSessionId = String(session.thebeSessionId);
    await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/session/${parentSessionId}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "parent-secret-transcript" }),
      }),
    );
    const spawned = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/subagents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profileName: "diagnostics",
            task: "inspect health",
            parentSessionId,
          }),
        }),
      ),
    );
    const runId = String(spawned.runId);
    await app.agent.waitSubagent(runId);

    const detail = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/activity/${runId}`),
    );
    expect(detail.status).toBe(200);
    const body = await json(detail);
    expect(body).toEqual(
      expect.objectContaining({
        type: "worker",
        id: runId,
        worker: expect.objectContaining({
          runId,
          parentSessionId,
          status: "completed",
        }),
      }),
    );
    expect(JSON.stringify(body)).not.toContain("parent transcript");
  });

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
      if (run.status === "succeeded" || run.status === "failed" || run.status === "interrupted") break;
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

  it("documents worker items in the Activity OpenAPI contract", async () => {
    const { createThebeHttpHandler } = await import("./handler.ts");
    const response = await createThebeHttpHandler({ version: "0.1.0" }).handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const document = (await response.json()) as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    expect(document.components.schemas).toEqual(
      expect.objectContaining({
        ActivityItem: expect.objectContaining({
          oneOf: expect.arrayContaining([
            { $ref: "#/components/schemas/ActivityWorkerItem" },
          ]),
        }),
        ActivityWorkerItem: expect.objectContaining({
          properties: expect.objectContaining({
            worker: { $ref: "#/components/schemas/ProductWorker" },
          }),
        }),
      }),
    );
  });

  it("documents background-task items in the Activity OpenAPI contract", async () => {
    const { createThebeHttpHandler } = await import("./handler.ts");
    const response = await createThebeHttpHandler({ version: "0.1.0" }).handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const document = (await response.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const activityGet = document.paths["/v1/activity"]?.get;
    expect(activityGet?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "source",
          schema: expect.objectContaining({
            enum: expect.arrayContaining(["background_task"]),
          }),
        }),
      ]),
    );
    expect(document.components.schemas).toEqual(
      expect.objectContaining({
        ActivityItem: expect.objectContaining({
          oneOf: expect.arrayContaining([
            { $ref: "#/components/schemas/ActivityBackgroundTaskItem" },
          ]),
        }),
        ActivityBackgroundTaskItem: expect.objectContaining({
          properties: expect.objectContaining({
            task: { $ref: "#/components/schemas/ProductBackgroundTask" },
          }),
        }),
        ProductBackgroundTask: expect.objectContaining({
          properties: expect.objectContaining({
            provider: { type: "string" },
            kind: { type: "string" },
            error: { type: "string" },
          }),
        }),
      }),
    );
  });

  it("documents the Diagnosis Artifact link in OpenAPI", async () => {
    const { createThebeHttpHandler } = await import("./handler.ts");
    const response = await createThebeHttpHandler({ version: "0.1.0" }).handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const document = (await response.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    expect(document.paths["/v1/diagnosis"]?.post?.responses).toEqual(
      expect.objectContaining({
        "200": expect.objectContaining({
          content: expect.objectContaining({
            "application/json": expect.objectContaining({
              schema: { $ref: "#/components/schemas/DiagnosisResult" },
            }),
          }),
        }),
      }),
    );
    expect(document.components.schemas.DiagnosisResult).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({ artifactId: { type: "string" } }),
      }),
    );
  });

  it("documents Activity pagination in the OpenAPI contract", async () => {
    const { createThebeHttpHandler } = await import("./handler.ts");
    const response = await createThebeHttpHandler({ version: "0.1.0" }).handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const document = (await response.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const activityGet = document.paths["/v1/activity"]?.get;
    expect(activityGet?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "group", in: "query" }),
        expect.objectContaining({ name: "limit", in: "query" }),
        expect.objectContaining({ name: "cursor", in: "query" }),
        expect.objectContaining({
          name: "source",
          in: "query",
          schema: expect.objectContaining({ enum: expect.arrayContaining(["diagnosis"]) }),
        }),
        expect.objectContaining({ name: "status", in: "query" }),
        expect.objectContaining({ name: "updatedAfter", in: "query" }),
        expect.objectContaining({ name: "updatedBefore", in: "query" }),
      ]),
    );
    expect(document.components.schemas.ActivityList).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          nextCursor: { type: "string" },
        }),
      }),
    );
  });

  it("uses named schemas for embedded Activity source objects", async () => {
    const { createThebeHttpHandler } = await import("./handler.ts");
    const response = await createThebeHttpHandler({ version: "0.1.0" }).handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const document = (await response.json()) as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const schemas = document.components.schemas;

    expect(schemas.ResourceRef).toEqual(
      expect.objectContaining({
        type: "object",
        required: ["kind", "id", "provider"],
      }),
    );
    expect(schemas.ActivityRecord).toEqual(
      expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          resource: { $ref: "#/components/schemas/ResourceRef" },
        }),
      }),
    );
    expect(schemas.ActivityApprovalItem?.properties).toEqual(
      expect.objectContaining({
        approval: { $ref: "#/components/schemas/ActivityRecord" },
      }),
    );
    expect(schemas.ActivityReceiptItem?.properties).toEqual(
      expect.objectContaining({
        receipt: { $ref: "#/components/schemas/ActivityRecord" },
      }),
    );
    expect(schemas.ActivityDiagnosisItem?.properties).toEqual(
      expect.objectContaining({
        diagnosis: { $ref: "#/components/schemas/ActivityRecord" },
      }),
    );
    expect(schemas.ActivityItem?.oneOf).toEqual(
      expect.arrayContaining([
        { $ref: "#/components/schemas/ActivityDiagnosisItem" },
      ]),
    );
    expect(schemas.ActivityGoalItem?.properties).toEqual(
      expect.objectContaining({
        goal: { $ref: "#/components/schemas/ProductGoal" },
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

  it("pages the unified Activity feed with a stable cursor", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const first = await json(await postAction(app.handler, { idempotencyKey: "page-1" }));
    const second = await json(await postAction(app.handler, { idempotencyKey: "page-2" }));
    const third = await json(await postAction(app.handler, { idempotencyKey: "page-3" }));
    const receiptIds = [String(first.receiptId), String(second.receiptId), String(third.receiptId)];

    const firstPage = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/activity?limit=2"),
      ),
    );
    const firstItems = firstPage.items as Array<Record<string, unknown>>;
    expect(firstItems).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await json(
      await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/activity?limit=2&cursor=${encodeURIComponent(String(firstPage.nextCursor))}`,
        ),
      ),
    );
    const secondItems = secondPage.items as Array<Record<string, unknown>>;
    expect(secondItems).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(
      [...firstItems, ...secondItems].map((item) => String(item.id)).sort(),
    ).toEqual(receiptIds.sort());
  });

  it("rejects invalid Activity pagination inputs", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const invalidLimit = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/activity?limit=0"),
    );
    expect(invalidLimit.status).toBe(400);
    expect(await json(invalidLimit)).toEqual({
      ok: false,
      error: "limit must be a positive integer",
      code: "invalid_body",
    });

    const invalidCursor = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/activity?cursor=not-a-cursor"),
    );
    expect(invalidCursor.status).toBe(400);
    expect(await json(invalidCursor)).toEqual({
      ok: false,
      error: "cursor is invalid",
      code: "invalid_body",
    });
  });

  it("rejects invalid Activity filter inputs", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const invalidSource = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/activity?source=timeline"),
    );
    expect(invalidSource.status).toBe(400);
    expect(await json(invalidSource)).toEqual({
      ok: false,
      error: "source is invalid",
      code: "invalid_body",
    });

    const emptyStatus = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/activity?status="),
    );
    expect(emptyStatus.status).toBe(400);
    expect(await json(emptyStatus)).toEqual({
      ok: false,
      error: "status must not be empty",
      code: "invalid_body",
    });

    const invalidTime = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/activity?updatedAfter=not-a-time"),
    );
    expect(invalidTime.status).toBe(400);
    expect(await json(invalidTime)).toEqual({
      ok: false,
      error: "updatedAfter must be an ISO-8601 timestamp",
      code: "invalid_body",
    });
  });

  it("filters Activity by source before pagination", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/diagnosis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: { kind: "container", id: "ctr-emby", name: "emby", provider: "arcane" },
        }),
      }),
    );
    await postAction(app.handler, {
      idempotencyKey: "source-receipt",
      resource: { kind: "container", id: "ctr-other", name: "other", provider: "arcane" },
    });

    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/activity?source=approval&limit=1"),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.items).toEqual([
      expect.objectContaining({ type: "approval", group: "needs_approval" }),
    ]);
    expect(body.nextCursor).toBeUndefined();
  });

  it("filters Activity by source status", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    await postAction(app.handler, { idempotencyKey: "status-succeeded" });
    await postAction(app.handler, {
      idempotencyKey: "status-rejected",
      approval: { approved: false, client: "ios" },
    });

    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/activity?status=rejected"),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.items).toEqual([
      expect.objectContaining({
        type: "receipt",
        receipt: expect.objectContaining({ status: "rejected" }),
      }),
    ]);
  });

  it("filters Activity by updatedAt time boundaries", async () => {
    let current = "2026-09-21T00:00:01.000Z";
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      now: () => new Date(current),
    });
    const first = await json(await postAction(app.handler, { idempotencyKey: "time-first" }));
    current = "2026-09-21T00:00:03.000Z";
    const second = await json(await postAction(app.handler, { idempotencyKey: "time-second" }));

    const after = await json(
      await app.handler.handle(
        new Request(
          "http://127.0.0.1:8787/v1/activity?updatedAfter=2026-09-21T00:00:02.000Z",
        ),
      ),
    );
    expect(after.items).toEqual([
      expect.objectContaining({ id: second.receiptId }),
    ]);

    const before = await json(
      await app.handler.handle(
        new Request(
          "http://127.0.0.1:8787/v1/activity?updatedBefore=2026-09-21T00:00:02.000Z",
        ),
      ),
    );
    expect(before.items).toEqual([
      expect.objectContaining({ id: first.receiptId }),
    ]);
  });

  it("exposes read-only diagnoses as typed Activity items", async () => {
    const runningProvider = provider("running");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: {
        ...runningProvider,
        getStatusSummary: async () => {
          throw new Error("summary unavailable");
        },
      },
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
    expect(diagnosed.approvalId).toBeUndefined();

    const listed = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/activity?source=diagnosis"),
      ),
    );
    expect(listed.items).toEqual([
      expect.objectContaining({
        type: "diagnosis",
        id: diagnosed.runId,
        group: "recent",
        diagnosis: expect.objectContaining({
          id: diagnosed.runId,
          kind: "container.diagnose",
          status: "completed",
        }),
      }),
    ]);

    const detail = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/activity/${diagnosed.runId}`),
    );
    expect(detail.status).toBe(200);
    expect(await json(detail)).toEqual(
      expect.objectContaining({ type: "diagnosis", id: diagnosed.runId }),
    );
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

  it("links a bounded diagnosis Artifact from the diagnosis and Activity contracts", async () => {
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
    const artifactId = String(diagnosed.artifactId);
    expect(diagnosed.artifactId).toEqual(expect.any(String));

    const metadata = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${artifactId}`),
      ),
    );
    expect(metadata).toEqual(
      expect.objectContaining({
        artifactId,
        kind: "diagnosis",
        runId: diagnosed.runId,
        resource: { kind: "container", id: "ctr-emby" },
      }),
    );

    const content = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${artifactId}/content`),
      ),
    );
    expect(String(content.content)).toContain(String(diagnosed.runId));
    expect(String(content.content)).not.toContain("toolTranscript");

    const activity = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/activity?group=needs_approval"),
      ),
    );
    expect(activity.items).toEqual([
      expect.objectContaining({
        approval: expect.objectContaining({ artifactId }),
      }),
    ]);
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
