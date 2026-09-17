import { describe, expect, it } from "vitest";
import { ProviderError, type ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

const SECRET = "sk-live-http-secret";

function provider(mode: "ok" | "down" = "ok"): ContainerInfoProvider {
  if (mode === "down") {
    return {
      listContainers: async () => [],
      inspectContainer: async () => {
        throw new ProviderError("UNREACHABLE", "provider down");
      },
      getContainerLogs: async () => {
        throw new ProviderError("UNREACHABLE", "provider down");
      },
      getStatusSummary: async () => {
        throw new ProviderError("UNREACHABLE", "provider down");
      },
    };
  }
  return {
    listContainers: async () => [],
    inspectContainer: async (id) => ({
      id,
      name: "emby",
      image: "emby/embyserver:4.8",
      state: "exited",
      config: { env: [`API_TOKEN=${SECRET}`], cmd: ["/init"] },
    }),
    getContainerLogs: async () => `fatal token=${SECRET}`,
    getStatusSummary: async () => ({
      totalContainers: 2,
      runningContainers: 1,
      pausedContainers: 0,
      exitedContainers: 1,
      lastUpdated: 1,
    }),
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("POST /v1/diagnosis", () => {
  it("runs the product diagnosis path without exposing MCP or secrets", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/diagnosis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: {
            kind: "container",
            id: "ctr-emby",
            name: "emby",
            provider: "arcane",
            instanceId: "a1",
            environmentId: "0",
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.actionId).toBe("container.diagnose");
    expect(body.resource).toEqual(
      expect.objectContaining({ id: "ctr-emby", provider: "arcane" }),
    );
    expect(Array.isArray(body.observations)).toBe(true);
    expect(body.diagnosis).toEqual(expect.objectContaining({ code: "container_exited" }));
    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(typeof body.runId).toBe("string");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("internalState");

    const fetched = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/diagnosis/${body.runId}`),
    );
    expect(fetched.status).toBe(200);
    expect((await json(fetched)).runId).toBe(body.runId);
  });

  it("rejects a missing resource id", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/diagnosis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: { kind: "container" } }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 503 when the container provider is unreachable", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider("down"),
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/diagnosis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: { kind: "container", id: "ctr-emby", provider: "arcane" },
        }),
      }),
    );
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.status).toBe("provider_unavailable");
    expect(body.observations).toEqual([]);
  });

  it("returns 503 when the agent is not wired", async () => {
    const { createThebeHttpHandler } = await import("./handler.ts");
    const handler = createThebeHttpHandler({ version: "0.1.0" });
    const res = await handler.handle(
      new Request("http://127.0.0.1:8787/v1/diagnosis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: { kind: "container", id: "ctr-emby", provider: "arcane" },
        }),
      }),
    );
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.error).toMatch(/unavailable/i);
  });
});
