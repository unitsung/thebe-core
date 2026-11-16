import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNotificationService } from "../../agent/notifications/service.ts";
import { createNotificationChannelConfigService } from "../../agent/notifications/channel-config-service.ts";
import type { NotificationAdapter } from "../../agent/notifications/types.ts";
import { createThebeHttpHandler } from "./handler.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "thebe-notifications-http-"));
  dirs.push(dir);
  const sent: Array<{
    targetId: string;
    id: string;
    body: string;
    url?: string;
  }> = [];
  const adapter: NotificationAdapter = {
    id: "webhook",
    accepts: () => true,
    send: async (input) => {
      sent.push({
        targetId: input.target.id,
        id: input.notification.id,
        body: input.notification.body,
        url: input.target.channel.address?.url,
      });
      return { status: "sent" };
    },
  };
  const notifications = createNotificationService({
    dir,
    adapters: [adapter],
  });
  const notificationConfig = createNotificationChannelConfigService({
    dir: join(dir, "config"),
    buildAdapters: (config) => [
      adapter,
      ...(config.telegram?.botToken
        ? [
            {
              id: "telegram",
              accepts: () => true,
              send: async () => ({ status: "sent" as const }),
            },
          ]
        : []),
    ],
    onChange: (adapters) => notifications.setAdapters(adapters),
    watch: false,
  });
  const handler = createThebeHttpHandler({
    version: "test",
    token: "secret",
    notifications,
    notificationConfig,
  });
  async function call(path: string, init: RequestInit = {}) {
    const response = await handler.handle(
      new Request(`http://127.0.0.1:8787${path}`, {
        ...init,
        headers: {
          "X-Thebe-Token": "secret",
          "content-type": "application/json",
          ...init.headers,
        },
      })
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }
  return { notifications, notificationConfig, sent, call };
}

const target = {
  id: "ops",
  label: "Ops",
  channel: {
    source: "webhook",
    thread: "ops",
    address: { url: "https://example.test/hook?token=hidden" },
  },
  categories: "all",
  enabled: true,
};

describe("notification HTTP routes", () => {
  it("lists every channel and marks the ones this host can deliver through", async () => {
    const { call } = await setup();
    const response = await call("/v1/notifications/channels");
    expect(response.status).toBe(200);
    const channels = response.body.channels as Array<{
      id: string;
      available: boolean;
      addressFields: Array<{ key: string; required: boolean }>;
    }>;
    expect(channels.length).toBeGreaterThan(15);
    expect(channels.find((channel) => channel.id === "webhook")).toMatchObject({
      available: true,
    });
    expect(
      channels.find((channel) => channel.id === "webhook")?.addressFields
    ).toContainEqual(expect.objectContaining({ key: "url", required: true }));
    expect(channels.find((channel) => channel.id === "telegram")).toMatchObject(
      {
        available: false,
      }
    );
  });

  it("saves settings, redacts credentials, and routes an external send", async () => {
    const { notifications, sent, call } = await setup();
    const saved = await call("/v1/notifications/settings", {
      method: "PUT",
      body: JSON.stringify({ targets: [target] }),
    });
    expect(saved.status).toBe(200);
    const savedTarget = (
      saved.body.settings as {
        targets: Array<{ channel: { address: Record<string, string> } }>;
      }
    ).targets[0]!;
    expect(savedTarget.channel.address.url).toContain("token=***REDACTED***");

    const read = await call("/v1/notifications/settings");
    expect(read.status).toBe(200);
    expect(read.body.settings).toMatchObject({ targets: [{ id: "ops" }] });

    const send = await call("/v1/notifications/send", {
      method: "POST",
      body: JSON.stringify({
        id: "deploy-42",
        category: "pipeline",
        priority: "normal",
        title: "Deploy finished",
        body: "The nightly run finished.",
        deepLink: "thebe://pipeline/42",
      }),
    });
    expect(send.status).toBe(202);
    expect(send.body).toMatchObject({
      ok: true,
      id: "deploy-42",
      targets: ["ops"],
    });
    await notifications.flush();
    expect(sent).toEqual([
      {
        targetId: "ops",
        id: "deploy-42",
        body: "The nightly run finished.",
        url: "https://example.test/hook?token=hidden",
      },
    ]);
  });

  it("restores a masked secret when a read settings document is written back", async () => {
    const { notifications, sent, call } = await setup();
    await call("/v1/notifications/settings", {
      method: "PUT",
      body: JSON.stringify({ targets: [target] }),
    });
    const read = await call("/v1/notifications/settings");
    const roundTrip = await call("/v1/notifications/settings", {
      method: "PUT",
      body: JSON.stringify(read.body.settings),
    });
    expect(roundTrip.status).toBe(200);
    await call("/v1/notifications/send", {
      method: "POST",
      body: JSON.stringify({
        id: "deploy-43",
        category: "pipeline",
        priority: "normal",
        title: "Deploy finished",
        body: "The nightly run finished.",
      }),
    });
    await notifications.flush();
    expect(sent.at(-1)?.url).toBe("https://example.test/hook?token=hidden");
  });

  it("never moves a masked URL secret to a different host", async () => {
    const { notifications, sent, call } = await setup();
    await call("/v1/notifications/settings", {
      method: "PUT",
      body: JSON.stringify({ targets: [target] }),
    });
    const read = await call("/v1/notifications/settings");
    const settings = read.body.settings as {
      targets: Array<{ channel: { address: Record<string, string> } }>;
    };
    settings.targets[0]!.channel.address.url =
      "https://other.example/hook?token=***REDACTED***";
    const saved = await call("/v1/notifications/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    expect(saved.status).toBe(200);
    await call("/v1/notifications/send", {
      method: "POST",
      body: JSON.stringify({
        id: "deploy-44",
        category: "pipeline",
        priority: "normal",
        title: "Deploy finished",
        body: "The nightly run finished.",
      }),
    });
    await notifications.flush();
    expect(sent.at(-1)?.url).toBe(
      "https://other.example/hook?token=***REDACTED***"
    );
  });

  it("reports digest-held notices without queueing them yet", async () => {
    const { notifications, sent, call } = await setup();
    await call("/v1/notifications/settings", {
      method: "PUT",
      body: JSON.stringify({
        targets: [
          {
            ...target,
            digest: { windowMinutes: 5, categories: ["pipeline"] },
          },
        ],
      }),
    });
    await call("/v1/notifications/send", {
      method: "POST",
      body: JSON.stringify({
        id: "deploy-45",
        category: "pipeline",
        priority: "normal",
        title: "Deploy finished",
        body: "The nightly run finished.",
      }),
    });
    await notifications.flush();
    expect(sent).toEqual([]);
    const status = await call("/v1/notifications/status");
    expect(status.body).toMatchObject({
      pending: 0,
      targets: [{ targetId: "ops", digestPending: 1 }],
    });
  });

  it("sends a test notice directly and reports an unknown target", async () => {
    const { call } = await setup();
    await call("/v1/notifications/settings", {
      method: "PUT",
      body: JSON.stringify({ targets: [target] }),
    });
    const test = await call("/v1/notifications/test", {
      method: "POST",
      body: JSON.stringify({ targetId: "ops" }),
    });
    expect(test.status).toBe(200);
    expect(test.body).toMatchObject({
      ok: true,
      targetId: "ops",
      status: "sent",
    });

    const missing = await call("/v1/notifications/test", {
      method: "POST",
      body: JSON.stringify({ targetId: "nope" }),
    });
    expect(missing.status).toBe(404);
  });

  it("rejects invalid settings and an invalid send body", async () => {
    const { call } = await setup();
    const settings = await call("/v1/notifications/settings", {
      method: "PUT",
      body: JSON.stringify({ targets: [{ ...target, categories: ["nope"] }] }),
    });
    expect(settings.status).toBe(400);
    expect(settings.body.code).toBe("invalid_notification_settings");

    const send = await call("/v1/notifications/send", {
      method: "POST",
      body: JSON.stringify({
        category: "nope",
        priority: "high",
        title: "x",
        body: "y",
      }),
    });
    expect(send.status).toBe(400);
    expect(send.body.code).toBe("invalid_notification");
  });

  it("reads, masks, and updates channel credentials", async () => {
    const { notificationConfig, notifications, call } = await setup();
    const empty = await call("/v1/notifications/config");
    expect(empty.status).toBe(200);
    expect(empty.body.config).toEqual({});
    expect(empty.body.fields).toEqual(expect.any(Array));

    const saved = await call("/v1/notifications/config", {
      method: "PUT",
      body: JSON.stringify({
        config: { telegram: { botToken: "do-not-print-me" } },
      }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.config).toMatchObject({
      telegram: { botToken: "***REDACTED***" },
    });
    expect(JSON.stringify(saved.body)).not.toContain("do-not-print-me");
    expect((await notificationConfig.get()).telegram?.botToken).toBe(
      "do-not-print-me"
    );
    expect(
      notifications.channels().find((channel) => channel.id === "telegram")
        ?.available
    ).toBe(true);

    const kept = await call("/v1/notifications/config", {
      method: "PUT",
      body: JSON.stringify({ config: saved.body.config }),
    });
    expect(kept.status).toBe(200);
    expect((await notificationConfig.get()).telegram?.botToken).toBe(
      "do-not-print-me"
    );
  });

  it("reports status without notification bodies", async () => {
    const { notifications, call } = await setup();
    await call("/v1/notifications/settings", {
      method: "PUT",
      body: JSON.stringify({ targets: [target] }),
    });
    await call("/v1/notifications/send", {
      method: "POST",
      body: JSON.stringify({
        id: "deploy-42",
        category: "pipeline",
        priority: "normal",
        title: "Deploy finished",
        body: "Secret deployment details.",
      }),
    });
    await notifications.flush();
    const status = await call("/v1/notifications/status");
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).not.toContain(
      "Secret deployment details"
    );
    expect(status.body).toMatchObject({
      pending: 0,
      dropped: 0,
      targets: [{ targetId: "ops", lastSentAt: expect.any(String) }],
    });
  });
});
