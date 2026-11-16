import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNotificationChannelConfigStore } from "../../../agent/notifications/channel-config.ts";
import { handleNotificationsCommand } from "./notifications.ts";
import type { SlashHost } from "./context.ts";

const originalConfigDir = process.env.THEBE_CONFIG_DIR;

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.THEBE_CONFIG_DIR;
  else process.env.THEBE_CONFIG_DIR = originalConfigDir;
});

function host(notices: string[]): SlashHost {
  return {
    notice: (text: string) => notices.push(text),
  } as unknown as SlashHost;
}

describe("/notifications", () => {
  it("prints the owner-only config path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tui-notifications-"));
    try {
      process.env.THEBE_CONFIG_DIR = dir;
      const notices: string[] = [];
      await handleNotificationsCommand(host(notices), "path");
      expect(notices[0]).toBe(join(dir, "notification-config.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists configured channels without printing secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tui-notifications-"));
    try {
      process.env.THEBE_CONFIG_DIR = dir;
      const store = createNotificationChannelConfigStore({ dir });
      await store.set({
        telegram: { botToken: "do-not-print-me" },
        wecom: { url: "https://example.test/hook?key=also-secret" },
      });
      const notices: string[] = [];
      await handleNotificationsCommand(host(notices), "list");
      expect(notices[0]).toContain("Telegram");
      expect(notices[0]).toContain("Bot token=••••••");
      expect(notices[0]).not.toContain("do-not-print-me");
      expect(notices[0]).not.toContain("also-secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
