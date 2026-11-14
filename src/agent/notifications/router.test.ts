import { describe, expect, it } from "vitest";
import { createNotificationOutbox } from "./outbox.ts";
import { createNotificationDigest } from "./digest.ts";
import { createNotificationRouter } from "./router.ts";
import type { NotificationSettingsStore } from "./settings.ts";
import type {
  Notification,
  NotificationAdapter,
  NotificationSettings,
  NotificationTarget,
} from "./types.ts";

function settingsFor(
  targets: NotificationTarget[],
  overrides: Partial<NotificationSettings> = {}
): NotificationSettings {
  return {
    version: 1,
    targets,
    criticalBypassesQuietHours: true,
    rateLimitPerHour: 60,
    updatedAt: "2026-11-14T10:00:00.000Z",
    ...overrides,
  };
}

function store(settings: NotificationSettings): NotificationSettingsStore {
  return {
    get: async () => settings,
    set: async () => settings,
  };
}

function target(
  id: string,
  source: string,
  overrides: Partial<NotificationTarget> = {}
): NotificationTarget {
  return {
    id,
    channel: { source, thread: id },
    categories: "all",
    enabled: true,
    ...overrides,
  };
}

function notice(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "event-1",
    category: "attention",
    priority: "critical",
    title: "Thebe",
    body: "Something needs you.",
    createdAt: "2026-11-14T10:00:00.000Z",
    ...overrides,
  };
}

function adapter(
  id: string,
  send: NotificationAdapter["send"]
): NotificationAdapter {
  return { id, accepts: () => true, send };
}

describe("notification router", () => {
  it("selects targets by category, priority, and enabled state", async () => {
    const sent: string[] = [];
    const outbox = createNotificationOutbox({
      send: async (input) => {
        sent.push(input.targetId);
        return { status: "sent" };
      },
    });
    const router = createNotificationRouter({
      settings: store(
        settingsFor([
          target("ops", "webhook"),
          target("low-only", "webhook", { minPriority: "critical" }),
          target("completed", "webhook", { categories: ["completed"] }),
          target("off", "webhook", { enabled: false }),
        ])
      ),
      outbox,
      adapters: [adapter("webhook", async () => ({ status: "sent" }))],
    });

    const result = await router.notify(notice({ priority: "normal" }));
    expect(result.targets).toEqual(["ops"]);
    expect(result.skipped).toBe(0);
    await router.flush();
    expect(sent).toEqual(["ops"]);
  });

  it("deduplicates targets that point at the same channel", async () => {
    const sent: string[] = [];
    const outbox = createNotificationOutbox({
      send: async (input) => {
        sent.push(input.targetId);
        return { status: "sent" };
      },
    });
    const router = createNotificationRouter({
      settings: store(
        settingsFor([
          target("first", "webhook"),
          {
            ...target("second", "webhook"),
            channel: { source: "webhook", thread: "first" },
          },
        ])
      ),
      outbox,
      adapters: [adapter("webhook", async () => ({ status: "sent" }))],
    });
    await router.notify(notice());
    await router.flush();
    expect(sent).toEqual(["first"]);
  });

  it("lets a critical notice bypass quiet hours but holds a normal one until the window ends", async () => {
    let now = new Date("2026-11-14T23:30:00.000Z");
    const sent: string[] = [];
    const outbox = createNotificationOutbox({
      now: () => now,
      send: async (input) => {
        sent.push(input.notification.id);
        return { status: "sent" };
      },
    });
    const router = createNotificationRouter({
      now: () => now,
      settings: store(
        settingsFor([target("ops", "webhook")], {
          defaultQuietHours: { start: "23:00", end: "07:00", timeZone: "UTC" },
        })
      ),
      outbox,
      adapters: [adapter("webhook", async () => ({ status: "sent" }))],
    });

    await router.notify(notice({ id: "critical", priority: "critical" }));
    await router.notify(notice({ id: "normal", priority: "normal" }));
    await router.flush();
    expect(sent).toEqual(["critical"]);
    expect(
      (await outbox.pending()).map((entry) => entry.notification.id)
    ).toEqual(["normal"]);

    now = new Date("2026-11-15T07:00:01.000Z");
    await router.flush();
    expect(sent).toEqual(["critical", "normal"]);
  });

  it("holds a critical notice too when the bypass is disabled", async () => {
    let now = new Date("2026-11-14T23:30:00.000Z");
    const outbox = createNotificationOutbox({
      now: () => now,
      send: async () => ({ status: "sent" }),
    });
    const router = createNotificationRouter({
      now: () => now,
      settings: store(
        settingsFor([target("ops", "webhook")], {
          defaultQuietHours: { start: "23:00", end: "07:00", timeZone: "UTC" },
          criticalBypassesQuietHours: false,
        })
      ),
      outbox,
      adapters: [adapter("webhook", async () => ({ status: "sent" }))],
    });
    await router.notify(notice());
    expect(await outbox.pending()).toHaveLength(1);
  });

  it("rate limits normal notices per target without limiting critical ones", async () => {
    const outbox = createNotificationOutbox({
      send: async () => ({ status: "sent" }),
    });
    const router = createNotificationRouter({
      settings: store(
        settingsFor([target("ops", "webhook")], { rateLimitPerHour: 1 })
      ),
      outbox,
      adapters: [adapter("webhook", async () => ({ status: "sent" }))],
    });
    await router.notify(notice({ id: "one", priority: "normal" }));
    // A repeat of the same event is already known to the outbox and must not consume the window.
    const repeat = await router.notify(
      notice({ id: "one", priority: "normal" })
    );
    expect(repeat.targets).toEqual(["ops"]);
    const second = await router.notify(
      notice({ id: "two", priority: "normal" })
    );
    expect(second.targets).toEqual([]);
    expect(second.skipped).toBe(1);
    const critical = await router.notify(
      notice({ id: "three", priority: "critical" })
    );
    expect(critical.targets).toEqual(["ops"]);
    await router.flush();
    const status = await router.status();
    expect(status.dropped).toBe(1);
    expect(status.targets[0]).toMatchObject({ targetId: "ops", dropped: 1 });
  });

  it("isolates one target's failure from another", async () => {
    const sent: string[] = [];
    const outbox = createNotificationOutbox({
      send: async (input) => {
        if (input.targetId === "broken") {
          return { status: "retry", reason: "provider down" };
        }
        sent.push(input.targetId);
        return { status: "sent" };
      },
    });
    const router = createNotificationRouter({
      settings: store(
        settingsFor([target("broken", "webhook"), target("ok", "webhook")])
      ),
      outbox,
      adapters: [adapter("webhook", async () => ({ status: "sent" }))],
    });
    // The two targets share a channel source but have distinct threads, so both are selected.
    await router.notify(notice());
    await router.flush();
    expect(sent).toEqual(["ok"]);
    const pending = await outbox.pending();
    expect(pending.map((entry) => entry.targetId)).toEqual(["broken"]);
  });

  it("merges event-specific Ticket targets with configured targets and dedupes channels", async () => {
    const sent: string[] = [];
    const outbox = createNotificationOutbox({
      send: async (input) => {
        sent.push(input.target.id);
        return { status: "sent" };
      },
    });
    const ticketChannel = { source: "webhook", thread: "ticket-thread" };
    const router = createNotificationRouter({
      settings: store(
        settingsFor([
          target("ops", "webhook"),
          { ...target("same", "webhook"), channel: ticketChannel },
        ])
      ),
      outbox,
      adapters: [adapter("webhook", async () => ({ status: "sent" }))],
    });
    const result = await router.notify(notice({ ticketId: "ticket-1" }), {
      extraTargets: [
        {
          id: "ticket:abc",
          channel: ticketChannel,
          categories: "all",
          enabled: true,
        },
      ],
    });
    expect(result.targets).toEqual(["ops", "same"]);
    expect(result.skipped).toBe(1);
    await router.flush();
    expect(sent).toEqual(["ops", "same"]);
  });

  it("digests low/normal notices for a target but sends critical ones at once", async () => {
    let now = new Date("2026-11-14T10:00:00.000Z");
    const sent: string[] = [];
    const outbox = createNotificationOutbox({
      now: () => now,
      send: async (input) => {
        sent.push(input.notification.id);
        return { status: "sent" };
      },
    });
    const digest = createNotificationDigest({
      now: () => now,
      emit: async (digestTarget, notification) => {
        await outbox.enqueue([{ target: digestTarget, notification }]);
      },
    });
    const digestTarget = target("ops", "webhook", {
      digest: { windowMinutes: 5, categories: ["pipeline"] },
    });
    const router = createNotificationRouter({
      now: () => now,
      settings: store(settingsFor([digestTarget])),
      outbox,
      digest,
      adapters: [adapter("webhook", async () => ({ status: "sent" }))],
    });

    await router.notify(
      notice({ id: "low", category: "pipeline", priority: "normal" })
    );
    await router.notify(
      notice({ id: "critical", category: "pipeline", priority: "critical" })
    );
    await router.flush();
    expect(sent).toEqual(["critical"]);
    expect(await digest.pending()).toMatchObject([
      { targetId: "ops", count: 1 },
    ]);

    now = new Date("2026-11-14T10:05:01.000Z");
    await digest.flushDue();
    await router.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/^[a-f0-9]{32}$/);
    expect(await outbox.pending()).toEqual([]);
    expect(await digest.pending()).toEqual([]);
  });

  it("tests one target directly and reports an unknown target", async () => {
    const outbox = createNotificationOutbox({
      send: async () => ({ status: "sent" }),
    });
    const router = createNotificationRouter({
      settings: store(settingsFor([target("ops", "webhook")])),
      outbox,
      adapters: [adapter("webhook", async () => ({ status: "sent" }))],
    });
    const found = await router.test("ops");
    expect(found).toMatchObject({ found: true, attempt: { status: "sent" } });
    expect(await outbox.pending()).toEqual([]);
    expect(await router.test("missing")).toEqual({ found: false });
  });
});
