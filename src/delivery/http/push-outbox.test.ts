import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async (id) => ({
      id,
      name: "emby",
      image: "emby/embyserver:4.8",
      state: "exited",
      config: {},
    }),
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 1,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 1,
      lastUpdated: 1,
    }),
  };
}

async function setup(relayFetch: typeof fetch) {
  const agentStoreDir = await mkdtemp(join(tmpdir(), "thebe-push-http-"));
  dirs.push(agentStoreDir);
  const app = createThebeApp({
    runtime: createFakeRuntime().runtime,
    provider: provider(),
    agentStoreDir,
    pushRelayUrl: "https://relay.example",
    pushFetch: relayFetch,
  });
  await app.handler.handle(
    new Request("http://127.0.0.1:8787/v1/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "apns-token",
        platform: "ios",
        relayDeviceId: "relay-1",
        categories: ["thebe.permission"],
      }),
    })
  );
  return app;
}

const diagnose = (app: Awaited<ReturnType<typeof setup>>) =>
  app.handler.handle(
    new Request("http://127.0.0.1:8787/v1/diagnosis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource: {
          kind: "container",
          id: "ctr-emby",
          name: "emby",
          provider: "arcane",
        },
      }),
    })
  );

const health = async (app: Awaited<ReturnType<typeof setup>>) =>
  (await (
    await app.handler.handle(new Request("http://127.0.0.1:8787/v1/health"))
  ).json()) as Record<string, unknown>;

describe("approval push notices go through the outbox", () => {
  it("sends a pending approval to the relay and reports a healthy outbox", async () => {
    const sent: Record<string, unknown>[] = [];
    const app = await setup((async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    await diagnose(app);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      relayDeviceId: "relay-1",
      category: "thebe.permission",
      seq: 1,
    });
    expect(String(sent[0]!.deepLink)).toMatch(/^thebe:\/\/approval\//);
    expect(String(sent[0]!.id)).toMatch(/^approval-/);
    await vi.waitFor(async () =>
      expect((await health(app)).push).toMatchObject({
        pending: 0,
        consecutiveFailures: 0,
        dropped: 0,
      })
    );
  });

  it("shows consecutive failures in the health response while the relay is down, and keeps the notice", async () => {
    const app = await setup((async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch);

    await diagnose(app);

    await vi.waitFor(async () =>
      expect((await health(app)).push).toMatchObject({
        pending: 1,
        consecutiveFailures: 1,
        dropped: 0,
        lastError: expect.stringContaining("relay unreachable"),
      })
    );
  });

  it("leaves push out of the health response when no relay is configured", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    expect(await health(app)).toEqual({ ok: true, version: "0.1.0" });
  });
});
