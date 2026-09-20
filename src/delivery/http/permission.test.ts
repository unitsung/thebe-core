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

describe("pending-permission product HTTP", () => {
  it("lists, gets, and resolves a redacted runtime permission without joining Activity", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [{ name: "bash", args: { command: "ls", token: "sk-live-secret-value" } }],
      },
      { kind: "text", text: "after" },
    ]);
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const created = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      ),
    );
    const sessionId = String(created.thebeSessionId);
    const pending = app.agent.prompt("run", { thebeSessionId: sessionId });
    pending.catch(() => {});
    await vi.waitFor(() => {
      expect(app.agent.pendingPermissionIds().length).toBe(1);
    });

    const listed = await json(
      await app.handler.handle(new Request("http://127.0.0.1:8787/v1/permissions")),
    );
    const items = listed.permissions as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        id: app.agent.pendingPermissionIds()[0],
        sessionId,
        toolName: "bash",
        rememberScopes: ["request", "tool", "conversation"],
      }),
    );
    expect(JSON.stringify(items)).not.toContain("sk-live-secret-value");
    expect(items[0]?.input ?? items[0]?.argsSummary).toBeDefined();

    const permissionId = String(items[0]?.id);
    const got = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/permissions/${permissionId}`),
      ),
    );
    expect(got.id).toBe(permissionId);
    expect(JSON.stringify(got)).not.toContain("sk-live-secret-value");

    const activity = await json(
      await app.handler.handle(new Request("http://127.0.0.1:8787/v1/activity")),
    );
    const feed = (activity.items as Array<Record<string, unknown>>) ?? [];
    expect(feed.every((item) => item.type === "approval" || item.type === "receipt" || item.type === "goal")).toBe(true);
    expect(feed.some((item) => item.id === permissionId)).toBe(false);

    const resolved = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/permissions/${permissionId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response: "deny",
          remember: true,
          rememberScope: "request",
        }),
      }),
    );
    expect(resolved.status).toBe(200);
    await pending;
    expect(app.agent.pendingPermissionIds()).toHaveLength(0);

    const empty = await json(
      await app.handler.handle(new Request("http://127.0.0.1:8787/v1/permissions")),
    );
    expect(empty.permissions).toEqual([]);
  });

  it("keeps session-scoped permission resolve compatible", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    const created = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      ),
    );
    const sessionId = String(created.thebeSessionId);
    const pending = app.agent.prompt("run", { thebeSessionId: sessionId });
    pending.catch(() => {});
    await vi.waitFor(() => {
      expect(app.agent.pendingPermissionIds().length).toBe(1);
    });
    const permissionId = app.agent.pendingPermissionIds()[0]!;
    const res = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${sessionId}/permission/${permissionId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: "deny" }),
        },
      ),
    );
    expect(res.status).toBe(200);
    await pending;
  });
});
