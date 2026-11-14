import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNotificationService } from "../../agent/notifications/service.ts";
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
  const handler = createThebeHttpHandler({
    version: "test",
    token: "secret",
    notifications,
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
  return { notifications, sent, call };
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
