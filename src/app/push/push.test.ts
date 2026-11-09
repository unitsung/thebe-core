import { mkdtemp, rm } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerInfoProvider,
  ContainerState,
} from "../../agent/capabilities/containers.ts";
import { createDeviceRegistry } from "../../delivery/http/devices.ts";
import { createThebeHttpHandler } from "../../delivery/http/handler.ts";
import { createThebeApp } from "../create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createPushIdentity, pushEventMessage } from "./identity.ts";
import { createPushNotifier } from "./notifier.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thebe-push-"));
  dirs.push(dir);
  return dir;
}

function publicKeyOf(raw: string) {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(raw, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });
}

describe("push identity", () => {
  it("keeps the same key across restarts and signs what the public half verifies", async () => {
    const dir = await tempDir();
    const first = createPushIdentity({ dir });
    const again = createPushIdentity({ dir });
    expect(again.publicKey).toBe(first.publicKey);
    const signature = first.sign("hello");
    expect(
      verify(
        null,
        Buffer.from("hello"),
        publicKeyOf(first.publicKey),
        Buffer.from(signature, "base64url")
      )
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from("other"),
        publicKeyOf(first.publicKey),
        Buffer.from(signature, "base64url")
      )
    ).toBe(false);
  });
});

describe("push notifier", () => {
  it("sends one signed, minimal event per device that registered with the relay for the category", async () => {
    const dir = await tempDir();
    const devices = createDeviceRegistry({ dir });
    await devices.register({
      token: "t1",
      platform: "ios",
      relayDeviceId: "relay-1",
      categories: ["thebe.permission"],
    });
    await devices.register({
      token: "t2",
      platform: "ios",
      relayDeviceId: "relay-2",
      categories: ["thebe.activity"],
    });
    await devices.register({
      token: "t3",
      platform: "ios",
      categories: ["thebe.permission"],
    });
    const identity = createPushIdentity({ dir });
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const notifier = createPushNotifier({
      relayUrl: "https://relay.example",
      identity,
      devices,
      now: () => new Date("2026-11-01T00:00:00Z"),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return new Response("{}");
      }) as unknown as typeof fetch,
    });

    await notifier.notify({
      category: "thebe.permission",
      title: "Thebe",
      body: "An action is waiting for your approval.",
      deepLink: "thebe://approval/abc",
      id: "approval-abc",
    });
    await notifier.flush();
    notifier.close();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://relay.example/v1/events");
    const { signature, ...rest } = calls[0]!.body as {
      signature: string;
    } & Parameters<typeof pushEventMessage>[0];
    const event: Parameters<typeof pushEventMessage>[0] = rest;
    expect(event.relayDeviceId).toBe("relay-1");
    expect(event.ticket).toBe("approval-abc");
    expect(event.seq).toBe(1);
    // The signature is random base64, so it can contain "t1" by chance; only the readable fields matter.
    expect(JSON.stringify(rest)).not.toContain("t1");
    expect(
      verify(
        null,
        Buffer.from(pushEventMessage(event)),
        publicKeyOf(identity.publicKey),
        Buffer.from(signature, "base64url")
      )
    ).toBe(true);
  });

  it("keeps the notice queued when the relay is down", async () => {
    const dir = await tempDir();
    const devices = createDeviceRegistry({ dir });
    await devices.register({
      token: "t1",
      platform: "ios",
      relayDeviceId: "relay-1",
      categories: ["thebe.permission"],
    });
    const notifier = createPushNotifier({
      relayUrl: "https://relay.example",
      identity: createPushIdentity({ dir }),
      devices,
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    await expect(
      notifier.notify({
        category: "thebe.permission",
        title: "t",
        body: "b",
        deepLink: "thebe://home",
        id: "x",
      })
    ).resolves.toBeUndefined();
    expect(notifier.status()).toMatchObject({
      pending: 1,
      consecutiveFailures: 1,
      dropped: 0,
    });
    expect(notifier.status().lastError).toContain("relay unreachable");
    notifier.close();
  });
});

describe("push identity route", () => {
  it("reports where to register, and that push is off when no relay is set", async () => {
    const off = createThebeHttpHandler({ version: "0.1.0" });
    const offBody = (await (
      await off.handle(new Request("http://127.0.0.1:8787/v1/push/identity"))
    ).json()) as Record<string, unknown>;
    expect(offBody).toEqual({
      ok: true,
      available: false,
      publicKey: null,
      relayUrl: null,
    });

    const on = createThebeHttpHandler({
      version: "0.1.0",
      pushIdentity: { publicKey: "abc", relayUrl: "https://relay.example" },
    });
    const onBody = (await (
      await on.handle(new Request("http://127.0.0.1:8787/v1/push/identity"))
    ).json()) as Record<string, unknown>;
    expect(onBody).toEqual({
      ok: true,
      available: true,
      publicKey: "abc",
      relayUrl: "https://relay.example",
    });
  });

  it("reports outbox state on health only when push is on", async () => {
    const off = createThebeHttpHandler({ version: "0.1.0" });
    const offBody = (await (
      await off.handle(new Request("http://127.0.0.1:8787/v1/health"))
    ).json()) as Record<string, unknown>;
    expect(offBody).not.toHaveProperty("push");

    const on = createThebeHttpHandler({
      version: "0.1.0",
      pushOutbox: {
        status: () => ({
          pending: 2,
          consecutiveFailures: 3,
          dropped: 1,
          lastDrop: {
            id: "notice-1",
            reason: "relay refused (404): unknown device",
            at: "2026-11-01T00:00:00.000Z",
          },
        }),
      },
    });
    const onBody = (await (
      await on.handle(new Request("http://127.0.0.1:8787/v1/health"))
    ).json()) as Record<string, unknown>;
    expect(onBody.push).toEqual({
      pending: 2,
      consecutiveFailures: 3,
      dropped: 1,
      lastDrop: {
        id: "notice-1",
        reason: "relay refused (404): unknown device",
        at: "2026-11-01T00:00:00.000Z",
      },
    });
  });

  it("keeps the relay device id when the same device registers again without one", async () => {
    const dir = await tempDir();
    const devices = createDeviceRegistry({ dir });
    await devices.register({
      token: "t",
      platform: "ios",
      relayDeviceId: "relay-9",
      categories: [],
    });
    const again = await devices.register({
      token: "t",
      platform: "ios",
      categories: ["thebe.permission"],
    });
    expect(again.relayDeviceId).toBe("relay-9");
    expect(again.categories).toEqual(["thebe.permission"]);
  });

  it("stores the relay device id a device registers with", async () => {
    const dir = await tempDir();
    const app = createThebeHttpHandler({
      version: "0.1.0",
      deviceStoreDir: dir,
    });
    const response = await app.handle(
      new Request("http://127.0.0.1:8787/v1/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "t",
          platform: "ios",
          relayDeviceId: "relay-9",
          categories: ["thebe.permission"],
        }),
      })
    );
    expect(
      ((await response.json()) as Record<string, unknown>).relayDeviceId
    ).toBe("relay-9");
  });
});

describe("push app composition", () => {
  it("exposes the outbox on health when a relay is configured", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: emptyContainers(),
      agentStoreDir: await tempDir(),
      pushRelayUrl: "https://relay.example",
      pushFetch: (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    const body = (await (
      await app.handler.handle(new Request("http://127.0.0.1:8787/v1/health"))
    ).json()) as Record<string, unknown>;
    expect(body.push).toEqual({
      pending: 0,
      consecutiveFailures: 0,
      dropped: 0,
    });
  });

  it("turns a Goal attention into an ordered ticket notification", async () => {
    const dir = await tempDir();
    const calls: Array<Record<string, unknown>> = [];
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [
          {
            name: "goal_report",
            args: { state: "ask", question: "Which library?" },
          },
        ],
      },
    ]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: emptyContainers(),
      agentStoreDir: dir,
      pushRelayUrl: "https://relay.example",
      pushFetch: (async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(init.body as string) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "t1",
          platform: "ios",
          relayDeviceId: "relay-1",
          categories: ["thebe.activity"],
        }),
      })
    );
    const created = (await (
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/goals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            goal: "Move the library",
            allowAsk: true,
          }),
        })
      )
    ).json()) as Record<string, unknown>;
    await app.agent.waitGoal(String(created.id));
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toMatchObject({
      relayDeviceId: "relay-1",
      category: "thebe.activity",
      body: "A task has a question for you.",
      deepLink: expect.stringContaining("thebe://goal/"),
      ticket: created.ticketId,
      seq: 1,
    });
  });

  it("pushes one notice while model assessments stay unavailable", async () => {
    vi.useFakeTimers();
    const dir = await tempDir();
    const calls: Array<Record<string, unknown>> = [];
    const containers = switchableContainers(["emby", "plex"]);
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "error", message: "503 provider unavailable" },
      { kind: "error", message: "503 provider unavailable" },
    ]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: containers.provider,
      agentStoreDir: dir,
      sources: { containerHealth: true, intervalMs: 1000 },
      pushRelayUrl: "https://relay.example",
      pushFetch: (async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(init.body as string) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "t1",
          platform: "ios",
          relayDeviceId: "relay-1",
          categories: ["thebe.activity"],
        }),
      })
    );
    await app.agent.setPolicy({
      rules: ["Restart a media server that stopped"],
      acceptMode: "observe",
    });
    await vi.advanceTimersByTimeAsync(0); // Source baseline
    containers.set("emby", "exited");
    containers.set("plex", "exited");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await app.agent.listDecisions()).toHaveLength(2)
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      category: "thebe.activity",
      body: expect.stringContaining("could not reach the model provider"),
      deepLink: "thebe://core",
    });
    await app.agent.quiesce();
  });
});

function emptyContainers(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async (id) => ({
      id,
      name: id,
      image: "image",
      state: "running",
      config: {},
    }),
    getContainerLogs: async () => "",
    getStatusSummary: async () => ({
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 0,
    }),
  };
}

function switchableContainers(names: string[]) {
  const states = new Map(
    names.map((name) => [name, "running" as ContainerState])
  );
  const provider = {
    listContainers: async () =>
      [...states].map(([name, state]) => ({
        id: `id-${name}`,
        name,
        image: "image",
        state,
        status: state,
        created: 1,
      })),
    inspectContainer: async (id: string) => ({
      id,
      name: id.slice(3),
      image: "image",
      state: states.get(id.slice(3)) ?? "running",
      config: {},
    }),
    getContainerLogs: async () => "",
    getStatusSummary: async () => ({
      totalContainers: names.length,
      runningContainers: [...states.values()].filter(
        (state) => state === "running"
      ).length,
      pausedContainers: 0,
      exitedContainers: [...states.values()].filter(
        (state) => state === "exited"
      ).length,
      lastUpdated: 1,
    }),
  } as ContainerInfoProvider;
  return {
    provider,
    set(name: string, state: ContainerState) {
      states.set(name, state);
    },
  };
}
