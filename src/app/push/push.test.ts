import { mkdtemp, rm } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeviceRegistry } from "../../delivery/http/devices.ts";
import { createThebeHttpHandler } from "../../delivery/http/handler.ts";
import { createPushIdentity, pushEventMessage } from "./identity.ts";
import { createPushNotifier } from "./notifier.ts";

const dirs: string[] = [];
afterEach(async () => {
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

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://relay.example/v1/events");
    const { signature, ...rest } = calls[0]!.body as {
      signature: string;
    } & Parameters<typeof pushEventMessage>[0];
    const event: Parameters<typeof pushEventMessage>[0] = rest;
    expect(event.relayDeviceId).toBe("relay-1");
    expect(JSON.stringify(calls[0]!.body)).not.toContain("t1");
    expect(
      verify(
        null,
        Buffer.from(pushEventMessage(event)),
        publicKeyOf(identity.publicKey),
        Buffer.from(signature, "base64url")
      )
    ).toBe(true);
  });

  it("never throws when the relay is down", async () => {
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
