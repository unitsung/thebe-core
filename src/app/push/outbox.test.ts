import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceRegistry } from "../../delivery/http/devices.ts";
import { createPushIdentity } from "./identity.ts";
import {
  createPushNotifier,
  type DurablePushNotifier,
  type PushNotice,
} from "./notifier.ts";

const dirs: string[] = [];
const notifiers: DurablePushNotifier[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
});

afterEach(async () => {
  for (const notifier of notifiers.splice(0)) notifier.close();
  vi.useRealTimers();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thebe-outbox-"));
  dirs.push(dir);
  return dir;
}

type Received = {
  id: string;
  ticket?: string;
  seq?: number;
  device: string;
};

/** A relay stand-in: records what it accepted, and answers as the test says. */
function fakeRelay() {
  const received: Received[] = [];
  const attempts: [number, string][] = [];
  const start = Date.now();
  const state: {
    mode: "up" | "down" | "lost-response";
    respond?: (device: string, id: string) => Response | undefined;
  } = { mode: "up" };
  const fetchRelay = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      relayDeviceId: string;
      id: string;
      ticket?: string;
      seq?: number;
    };
    attempts.push([Math.round((Date.now() - start) / 1000), body.id]);
    if (state.mode === "down") throw new Error("connect ECONNREFUSED");
    const answer = state.respond?.(body.relayDeviceId, body.id);
    if (answer) return answer;
    // Like the real relay: an id it has seen is acknowledged but not delivered twice.
    if (
      !received.some(
        (row) => row.device === body.relayDeviceId && row.id === body.id
      )
    ) {
      received.push({
        device: body.relayDeviceId,
        id: body.id,
        ticket: body.ticket,
        seq: body.seq,
      });
    }
    if (state.mode === "lost-response") throw new Error("socket hang up");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { received, attempts, state, fetch: fetchRelay };
}

async function setup(
  options: {
    dir?: string;
    devices?: string[];
    relay?: ReturnType<typeof fakeRelay>;
  } = {}
) {
  const dir = options.dir ?? (await tempDir());
  const devices = createDeviceRegistry({ dir });
  for (const [index, relayDeviceId] of (
    options.devices ?? ["relay-1"]
  ).entries()) {
    await devices.register({
      token: `token-${index}`,
      platform: "ios",
      relayDeviceId,
      categories: ["thebe.permission", "thebe.activity"],
    });
  }
  const relay = options.relay ?? fakeRelay();
  const notifier = createPushNotifier({
    relayUrl: "https://relay.example",
    identity: createPushIdentity({ dir }),
    devices,
    fetch: relay.fetch,
    dir,
  });
  notifiers.push(notifier);
  return { dir, devices, relay, notifier };
}

const notice = (id: string, ticket = "ticket-a"): PushNotice => ({
  category: "thebe.activity",
  title: "Thebe",
  body: "Something needs you.",
  deepLink: `thebe://ticket/${ticket}`,
  id,
  ticket,
});

const advance = (seconds: number) =>
  vi.advanceTimersByTimeAsync(seconds * 1000);

describe("push outbox", () => {
  it("delivers a ticket's notices to a device in order, each with a sequence number", async () => {
    const { notifier, relay } = await setup();
    await notifier.notify(notice("n1"));
    await notifier.notify(notice("n2"));
    await notifier.notify(notice("n3"));
    await notifier.flush();
    expect(relay.received.map((row) => [row.id, row.ticket, row.seq])).toEqual([
      ["n1", "ticket-a", 1],
      ["n2", "ticket-a", 2],
      ["n3", "ticket-a", 3],
    ]);
  });

  it("numbers each ticket's notices separately for each device", async () => {
    const { notifier, relay } = await setup({
      devices: ["relay-1", "relay-2"],
    });
    await notifier.notify(notice("a1", "ticket-a"));
    await notifier.notify(notice("b1", "ticket-b"));
    await notifier.notify(notice("a2", "ticket-a"));
    await notifier.flush();
    const forDevice = (device: string, ticket: string) =>
      relay.received
        .filter((row) => row.device === device && row.ticket === ticket)
        .map((row) => [row.id, row.seq]);
    expect(forDevice("relay-1", "ticket-a")).toEqual([
      ["a1", 1],
      ["a2", 2],
    ]);
    expect(forDevice("relay-2", "ticket-a")).toEqual([
      ["a1", 1],
      ["a2", 2],
    ]);
    expect(forDevice("relay-2", "ticket-b")).toEqual([["b1", 1]]);
  });

  it("keeps every notice through a ten-minute relay outage and delivers each once, in order", async () => {
    const { notifier, relay } = await setup();
    relay.state.mode = "down";
    await notifier.notify(notice("n1"));
    await notifier.notify(notice("n2"));
    await advance(10 * 60);
    expect(relay.received).toEqual([]);
    expect(notifier.status().pending).toBe(2);
    expect(notifier.status().consecutiveFailures).toBeGreaterThanOrEqual(5);
    expect(notifier.status().dropped).toBe(0);

    relay.state.mode = "up";
    await advance(300);
    expect(relay.received.map((row) => [row.id, row.seq])).toEqual([
      ["n1", 1],
      ["n2", 2],
    ]);
    expect(notifier.status()).toMatchObject({
      pending: 0,
      consecutiveFailures: 0,
      dropped: 0,
    });
    await advance(3600);
    expect(relay.received).toHaveLength(2);
  });

  it("retries the head with back-off from 5 to 300 seconds while later notices wait behind it", async () => {
    const { notifier, relay } = await setup();
    relay.state.mode = "down";
    await notifier.notify(notice("n1"));
    await notifier.notify(notice("n2"));
    await advance(700);
    expect(relay.attempts).toEqual([
      [0, "n1"],
      [5, "n1"],
      [15, "n1"],
      [35, "n1"],
      [75, "n1"],
      [155, "n1"],
      [315, "n1"],
      [615, "n1"],
    ]);
    expect(relay.received).toEqual([]);
  });

  it("drops the head after three transient failures and moves the queue on", async () => {
    const { notifier, relay } = await setup();
    relay.state.respond = (_device, id) =>
      id === "n1"
        ? new Response(JSON.stringify({ error: "APNs refused the notice" }), {
            status: 502,
          })
        : undefined;
    await notifier.notify(notice("n1"));
    await notifier.notify(notice("n2"));
    await advance(1);
    expect(relay.received).toEqual([]);
    await advance(5);
    await advance(10);
    expect(relay.received.map((row) => row.id)).toEqual(["n2"]);
    expect(notifier.status()).toMatchObject({ pending: 0, dropped: 1 });
    expect(notifier.status().lastDrop).toMatchObject({
      id: "n1",
      reason: expect.stringContaining("APNs refused"),
    });
    await advance(3600);
    expect(relay.received.map((row) => row.id)).toEqual(["n2"]);
  });

  it("drops a notice at once when the relay refuses it for good, and records why", async () => {
    const { notifier, relay } = await setup();
    relay.state.respond = (_device, id) =>
      id === "n1"
        ? new Response(JSON.stringify({ error: "bad signature" }), {
            status: 401,
          })
        : undefined;
    await notifier.notify(notice("n1"));
    await notifier.notify(notice("n2"));
    await notifier.flush();
    expect(relay.received.map((row) => row.id)).toEqual(["n2"]);
    expect(notifier.status().dropped).toBe(1);
    expect(notifier.status().lastDrop).toMatchObject({
      id: "n1",
      reason: "relay refused (401): bad signature",
    });
    expect(notifier.status().consecutiveFailures).toBe(0);
  });

  it("drops a notice for a device the relay no longer knows without blocking another device", async () => {
    const { notifier, relay } = await setup({
      devices: ["relay-1", "relay-2"],
    });
    relay.state.respond = (device) =>
      device === "relay-1"
        ? new Response(JSON.stringify({ error: "unknown device" }), {
            status: 404,
          })
        : undefined;
    await notifier.notify(notice("n1"));
    await notifier.flush();
    expect(relay.received.map((row) => [row.device, row.id])).toEqual([
      ["relay-2", "n1"],
    ]);
    expect(notifier.status().dropped).toBe(1);
  });

  it("shows a notice once when the relay delivered it but the answer was lost", async () => {
    const { notifier, relay } = await setup();
    relay.state.mode = "lost-response";
    await notifier.notify(notice("n1"));
    await advance(1);
    expect(relay.received).toHaveLength(1);
    relay.state.mode = "up";
    await advance(300);
    expect(relay.received).toHaveLength(1);
    expect(notifier.status()).toMatchObject({ pending: 0, dropped: 0 });
  });

  it("ignores a notice id it was already given", async () => {
    const { notifier, relay } = await setup();
    await notifier.notify(notice("n1"));
    await notifier.notify(notice("n1"));
    await notifier.flush();
    await notifier.notify(notice("n1"));
    await notifier.flush();
    expect(relay.received).toHaveLength(1);
  });

  it("keeps undelivered notices across a Core restart", async () => {
    const first = await setup();
    first.relay.state.mode = "down";
    await first.notifier.notify(notice("n1"));
    await first.notifier.notify(notice("n2"));
    await advance(30);
    first.notifier.close();

    const second = await setup({ dir: first.dir });
    await advance(300);
    expect(second.relay.received.map((row) => [row.id, row.seq])).toEqual([
      ["n1", 1],
      ["n2", 2],
    ]);
  });

  it("continues a ticket's numbering and remembers delivered ids after a restart", async () => {
    const first = await setup();
    await first.notifier.notify(notice("n1"));
    await first.notifier.flush();
    first.notifier.close();

    const second = await setup({ dir: first.dir });
    await second.notifier.notify(notice("n1"));
    await second.notifier.notify(notice("n2"));
    await second.notifier.flush();
    expect(second.relay.received.map((row) => [row.id, row.seq])).toEqual([
      ["n2", 2],
    ]);
  });

  it("sends nothing to devices that did not ask for the category", async () => {
    const dir = await tempDir();
    const devices = createDeviceRegistry({ dir });
    await devices.register({
      token: "t",
      platform: "ios",
      relayDeviceId: "relay-1",
      categories: ["thebe.permission"],
    });
    const relay = fakeRelay();
    const notifier = createPushNotifier({
      relayUrl: "https://relay.example",
      identity: createPushIdentity({ dir }),
      devices,
      fetch: relay.fetch,
      dir,
    });
    notifiers.push(notifier);
    await notifier.notify(notice("n1"));
    await notifier.flush();
    expect(relay.received).toEqual([]);
    expect(notifier.status().pending).toBe(0);
  });
});
