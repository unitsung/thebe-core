import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeviceRegistry } from "./devices.ts";
import { createThebeHttpHandler } from "./handler.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function makeStoreDir(): Promise<string> {
  const dir = await mkdtemp(join("/tmp", "thebe-devices-"));
  tempDirs.push(dir);
  return dir;
}

function handler(deviceStoreDir: string) {
  return createThebeHttpHandler({ version: "0.1.0", deviceStoreDir });
}

describe("device registration product HTTP", () => {
  it("registers a redacted device and returns its stable registration id", async () => {
    const dir = await makeStoreDir();
    const app = handler(dir);

    const response = await app.handle(
      new Request("http://127.0.0.1:8787/v1/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "apns-secret-token",
          platform: "ios",
          deviceId: "iphone-17",
          categories: ["thebe.activity", "thebe.permission"],
        }),
      }),
    );

    expect(response.status).toBe(200);
    const registered = await json(response);
    expect(registered).toEqual(expect.objectContaining({
      ok: true,
      registered: true,
      platform: "ios",
      deviceId: "iphone-17",
      categories: ["thebe.activity", "thebe.permission"],
      registrationId: expect.stringMatching(/^ios_[a-f0-9]{32}$/),
    }));
    expect(JSON.stringify(registered)).not.toContain("apns-secret-token");

    const listed = await json(
      await app.handle(new Request("http://127.0.0.1:8787/v1/devices")),
    );
    expect(listed.devices).toEqual([expect.objectContaining({
      registrationId: registered.registrationId,
      deviceId: "iphone-17",
      platform: "ios",
    })]);
  });

  it("updates the existing token without creating a duplicate and survives handler recreation", async () => {
    const dir = await makeStoreDir();
    const firstApp = handler(dir);
    const first = await json(
      await firstApp.handle(
        new Request("http://127.0.0.1:8787/v1/devices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: "same-apns-token",
            platform: "ios",
            deviceId: "old-device-id",
            categories: ["thebe.activity"],
          }),
        }),
      ),
    );

    const secondApp = handler(dir);
    const second = await json(
      await secondApp.handle(
        new Request("http://127.0.0.1:8787/v1/devices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: "same-apns-token",
            platform: "ios",
            deviceId: "new-device-id",
            categories: ["thebe.permission"],
          }),
        }),
      ),
    );

    expect(second.registrationId).toBe(first.registrationId);
    expect(second.deviceId).toBe("new-device-id");
    expect(second.categories).toEqual(["thebe.permission"]);

    const listed = await json(
      await secondApp.handle(new Request("http://127.0.0.1:8787/v1/devices")),
    );
    expect(listed.devices).toHaveLength(1);
    expect((listed.devices as Array<Record<string, unknown>>)[0]?.deviceId).toBe("new-device-id");
  });

  it("rejects malformed categories and supports token de-registration", async () => {
    const dir = await makeStoreDir();
    const app = handler(dir);
    const invalid = await app.handle(
      new Request("http://127.0.0.1:8787/v1/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "valid-token",
          platform: "ios",
          categories: ["", "x".repeat(65)],
        }),
      }),
    );
    expect(invalid.status).toBe(400);

    const registered = await json(
      await app.handle(
        new Request("http://127.0.0.1:8787/v1/devices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "valid-token", platform: "ios" }),
        }),
      ),
    );
    const registrationId = String(registered.registrationId);
    const removed = await json(
      await app.handle(
        new Request(`http://127.0.0.1:8787/v1/devices/${registrationId}`, {
          method: "DELETE",
        }),
      ),
    );
    expect(removed).toEqual({ ok: true, removed: true, registrationId });

    const listed = await json(
      await app.handle(new Request("http://127.0.0.1:8787/v1/devices")),
    );
    expect(listed.devices).toEqual([]);
  });

  it("does not replace a devices.json it cannot parse", async () => {
    const dir = await makeStoreDir();
    const path = join(dir, "devices.json");
    await writeFile(path, '{"devices":');
    const registry = createDeviceRegistry({ dir });

    await expect(
      registry.register({
        token: "token",
        platform: "ios",
        categories: [],
      })
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe('{"devices":');
  });
});
