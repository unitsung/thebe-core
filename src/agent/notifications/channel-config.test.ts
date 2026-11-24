import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NotificationChannelConfigError,
  configuredNotificationChannels,
  createNotificationChannelConfigStore,
  loadNotificationChannelConfig,
  notificationChannelConfigPath,
  parseNotificationChannelConfig,
} from "./channel-config.ts";

describe("notification channel config", () => {
  it("round-trips owner-only credentials and ignores unknown fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-notification-config-"));
    try {
      const store = createNotificationChannelConfigStore({ dir });
      await store.set({
        telegram: { botToken: " 123:abc ", unknown: "ignored" },
        irc: { host: "irc.example", port: "6697", tls: "true" },
        unknown: { field: "ignored" },
      });
      expect(await store.get()).toEqual({
        telegram: { botToken: "123:abc" },
        irc: { host: "irc.example", port: "6697", tls: "true" },
      });
      expect(configuredNotificationChannels(await store.get())).toEqual([
        "telegram",
        "irc",
      ]);
      const mode =
        (await stat(notificationChannelConfigPath(dir))).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(await readFile(store.path, "utf8")).toContain("123:abc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing file as empty and rejects a corrupt one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-notification-config-"));
    try {
      expect(await loadNotificationChannelConfig(dir)).toEqual({});
      await writeFile(notificationChannelConfigPath(dir), "{", "utf8");
      await expect(loadNotificationChannelConfig(dir)).rejects.toBeInstanceOf(
        NotificationChannelConfigError
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-object values and non-string fields", () => {
    expect(() => parseNotificationChannelConfig([])).toThrow(
      NotificationChannelConfigError
    );
    expect(() =>
      parseNotificationChannelConfig({ telegram: { botToken: 42 } })
    ).toThrow(NotificationChannelConfigError);
  });
});
