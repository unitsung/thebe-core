import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNotificationSettingsStore,
  NotificationInputError,
  parseNotification,
  parseNotificationSettings,
  redactNotificationSettings,
} from "./settings.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});
const now = new Date("2026-11-14T10:00:00.000Z");

describe("notification settings", () => {
  it("defaults to no targets and a critical bypass", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-notification-settings-"));
    dirs.push(dir);
    const store = createNotificationSettingsStore({ dir, now: () => now });
    expect(await store.get()).toEqual({
      version: 1,
      targets: [],
      criticalBypassesQuietHours: true,
      rateLimitPerHour: 60,
      updatedAt: now.toISOString(),
    });
  });

  it("validates targets and writes an owner-only file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-notification-settings-"));
    dirs.push(dir);
    const store = createNotificationSettingsStore({ dir, now: () => now });
    const saved = await store.set({
      targets: [
        {
          id: "ops",
          label: "Ops",
          channel: {
            source: "webhook",
            thread: "ops",
            address: { url: "https://example.test/hook?token=secret" },
          },
          categories: ["attention", "budget"],
          minPriority: "normal",
          quietHours: { start: "22:00", end: "07:00", timeZone: "UTC" },
          enabled: true,
        },
      ],
      rateLimitPerHour: 12,
      criticalBypassesQuietHours: false,
    });
    expect(saved.targets).toHaveLength(1);
    const file = join(dir, "notifications.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain(
      "https://example.test/hook?token=secret"
    );
  });

  it("rejects invalid categories, priorities, quiet hours, and duplicate ids", () => {
    const valid = {
      id: "ops",
      channel: { source: "webhook", thread: "ops" },
      categories: "all",
      enabled: true,
    };
    expect(() =>
      parseNotificationSettings(
        { targets: [{ ...valid, categories: ["nope"] }] },
        now
      )
    ).toThrow(NotificationInputError);
    expect(() =>
      parseNotificationSettings(
        { targets: [{ ...valid, minPriority: "urgent" }] },
        now
      )
    ).toThrow(NotificationInputError);
    expect(() =>
      parseNotificationSettings(
        {
          targets: [{ ...valid, quietHours: { start: "7:00", end: "08:00" } }],
        },
        now
      )
    ).toThrow(NotificationInputError);
    expect(() =>
      parseNotificationSettings({ targets: [valid, valid] }, now)
    ).toThrow(/duplicate target id/);
  });

  it("masks credentials in the settings view", () => {
    const settings = parseNotificationSettings(
      {
        targets: [
          {
            id: "ops",
            channel: {
              source: "webhook",
              thread: "ops",
              address: {
                url: "https://example.test/hook?access_token=abc&x=1",
                secret: "very-secret",
                chatId: "42",
                deviceKey: "bark-device",
                user: "pushover-user",
                toUser: "ops",
              },
            },
            categories: "all",
            enabled: true,
          },
        ],
      },
      now
    );
    const view = redactNotificationSettings(settings);
    const address = view.targets[0]!.channel.address!;
    expect(address.url).toContain("access_token=***REDACTED***");
    expect(address.secret).toBe("***REDACTED***");
    expect(address.deviceKey).toBe("***REDACTED***");
    expect(address.user).toBe("***REDACTED***");
    expect(address.toUser).toBe("ops");
    expect(address.chatId).toBe("42");
  });

  it("parses an external notification and generates an id when missing", () => {
    const parsed = parseNotification(
      {
        category: "pipeline",
        priority: "low",
        title: "Deploy finished",
        body: "The nightly run finished.",
        deepLink: "thebe://pipeline/42",
      },
      { now, newId: () => "generated-id" }
    );
    expect(parsed.id).toBe("generated-id");
    expect(parsed.createdAt).toBe(now.toISOString());
    expect(parsed.category).toBe("pipeline");
  });

  it("rejects a notification with an unknown category or missing text", () => {
    expect(() =>
      parseNotification(
        { category: "other", priority: "low", title: "x", body: "y" },
        { now, newId: () => "id" }
      )
    ).toThrow(NotificationInputError);
    expect(() =>
      parseNotification(
        { category: "pipeline", priority: "low", title: "", body: "y" },
        { now, newId: () => "id" }
      )
    ).toThrow(NotificationInputError);
  });
});
