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

describe("POST /v1/action container.restart", () => {
  it("exposes restart capability metadata on GET /v1/capabilities", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(new Request("http://127.0.0.1:8787/v1/capabilities"));
    const body = await json(res);
    const capabilities = body.capabilities as Array<Record<string, unknown>>;
    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "container.restart",
          effect: "write",
          risk: "disruptive",
          approval: "required",
          permission: "confirm",
        }),
      ]),
    );
  });

  it("returns 403 and does not restart without approval", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionId: "container.restart",
          resource: { kind: "container", id: "ctr-emby", name: "emby", provider: "arcane" },
        }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.action).toEqual(expect.objectContaining({ status: "rejected" }));
    expect((body.approval as Record<string, unknown>).capability).toEqual(
      expect.objectContaining({ effect: "write", risk: "disruptive", approval: "required" }),
    );
  });

  it("executes an approved restart and returns a receipt", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionId: "container.restart",
          resource: { kind: "container", id: "ctr-emby", name: "emby", provider: "arcane" },
          approval: { approved: true, approvedAt: "2026-09-17T00:00:00Z", client: "ios" },
          idempotencyKey: "http-ok",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.actionId).toBe("container.restart");
    expect(body.action).toEqual(expect.objectContaining({ status: "succeeded" }));
    expect(body.verification).toEqual(
      expect.objectContaining({
        status: "passed",
      }),
    );
    const fetched = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/action/${body.receiptId}`),
    );
    expect(fetched.status).toBe(200);
    expect((await json(fetched)).receiptId).toBe(body.receiptId);
  });

  it("is idempotent for the same key", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const payload = {
      actionId: "container.restart",
      resource: { kind: "container", id: "ctr-emby", provider: "arcane" },
      approval: { approved: true },
      idempotencyKey: "dup",
    };
    const first = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      ),
    );
    const second = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      ),
    );
    expect(second.receiptId).toBe(first.receiptId);
  });

  it("returns 503 when the agent is not wired", async () => {
    const { createThebeHttpHandler } = await import("./handler.ts");
    const handler = createThebeHttpHandler({ version: "0.1.0" });
    const res = await handler.handle(
      new Request("http://127.0.0.1:8787/v1/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionId: "container.restart",
          resource: { kind: "container", id: "ctr-emby", provider: "arcane" },
          approval: { approved: true },
        }),
      }),
    );
    expect(res.status).toBe(503);
  });
});
