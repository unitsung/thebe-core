import { describe, expect, it } from "vitest";
import { createNotificationService } from "./service.ts";
import type { NotificationSettingsStore } from "./settings.ts";
import type {
  Notification,
  NotificationSettings,
  NotificationTarget,
} from "./types.ts";

function target(
  id: string,
  overrides: Partial<NotificationTarget> = {}
): NotificationTarget {
  return {
    id,
    channel: { source: "webhook", thread: id },
    categories: "all",
    enabled: true,
    ...overrides,
  };
}

function notice(overrides: Partial<Notification>): Notification {
  return {
    id: "event-1",
    category: "pipeline",
    priority: "normal",
    title: "Thebe",
    body: "The pipeline finished.",
    createdAt: "2026-11-14T10:00:00.000Z",
    ...overrides,
  };
}

describe("notification service", () => {
  it("delivers each digest summary only to its originating target", async () => {
    let now = new Date("2026-11-14T10:00:00.000Z");
    const digestTarget = target("digest", {
      digest: { windowMinutes: 5, categories: ["pipeline"] },
    });
    const immediateTarget = target("immediate");
    const settings: NotificationSettings = {
      version: 1,
      targets: [digestTarget, immediateTarget],
      criticalBypassesQuietHours: true,
      rateLimitPerHour: 60,
      updatedAt: "2026-11-14T10:00:00.000Z",
    };
    const settingsStore: NotificationSettingsStore = {
      get: async () => settings,
      set: async () => settings,
    };
    const sent: Array<{
      targetId: string;
      title: string;
    }> = [];
    const service = createNotificationService({
      settings: settingsStore,
      now: () => now,
      adapters: [
        {
          id: "webhook",
          accepts: () => true,
          send: async (input) => {
            sent.push({
              targetId: input.target.id,
              title: input.notification.title,
            });
            return { status: "sent" };
          },
        },
      ],
    });

    try {
      await service.notify(
        notice({
          id: "digest-me",
          title: "Nightly run",
        })
      );
      await service.notify(
        notice({
          id: "critical",
          title: "Critical run",
          priority: "critical",
        })
      );
      await service.flush();

      now = new Date("2026-11-14T10:05:01.000Z");
      await service.flush();

      expect(
        sent
          .filter((row) => row.title === "Thebe: 1 update")
          .map((row) => row.targetId)
      ).toEqual(["digest"]);
      expect(
        sent
          .filter((row) => row.title === "Critical run")
          .map((row) => row.targetId)
          .sort()
      ).toEqual(["digest", "immediate"]);
      expect(
        sent
          .filter((row) => row.targetId === "immediate")
          .map((row) => row.title)
      ).toEqual(["Nightly run", "Critical run"]);
    } finally {
      await service.stop();
    }
  });
});
