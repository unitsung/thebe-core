import { randomUUID } from "node:crypto";
import { notificationChannels } from "./channels.ts";
import { createNotificationDigest } from "./digest.ts";
import { deliverToAdapters } from "./delivery.ts";
import { createNotificationOutbox } from "./outbox.ts";
import { createNotificationRouter } from "./router.ts";
import {
  createNotificationSettingsStore,
  parseNotification,
  redactNotificationSettings,
  type NotificationSettingsStore,
} from "./settings.ts";
import type {
  Notification,
  NotificationAdapter,
  NotificationDeliveryAttempt,
  NotificationSettings,
  NotificationStatus,
  NotificationTarget,
} from "./types.ts";

export type NotificationService = ReturnType<typeof createNotificationService>;

/**
 * The notification composition: settings, selection, and a durable outbox shared by HTTP and the
 * business events Core already emits. Adapters are host supplied because credentials stay outside the
 * settings file.
 */
export function createNotificationService(options: {
  adapters?: readonly NotificationAdapter[];
  /** Where `notifications.json` and the outbox live. Unset: memory only. */
  dir?: string;
  settings?: NotificationSettingsStore;
  now?: () => Date;
  retryBaseMs?: number;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  const now = options.now ?? (() => new Date());
  let adapters = options.adapters ?? [];
  let adapterMap = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const settings =
    options.settings ??
    createNotificationSettingsStore({
      dir: options.dir,
      now,
    });
  const outbox = createNotificationOutbox({
    dir: options.dir,
    now,
    retryBaseMs: options.retryBaseMs,
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
    send: async (input) => {
      return deliverToAdapters(adapterMap, {
        target: input.target,
        notification: input.notification,
        idempotencyKey: input.idempotencyKey,
      });
    },
  });
  const routerRef: {
    current?: ReturnType<typeof createNotificationRouter>;
  } = {};
  const digest = createNotificationDigest({
    dir: options.dir,
    now,
    onError: options.onError,
    emit: async (target, notification) => {
      await routerRef.current?.notify(notification, {
        extraTargets: [target],
        skipDigest: true,
      });
    },
  });
  const router = createNotificationRouter({
    settings,
    outbox,
    adapters,
    digest,
    now,
    onError: options.onError,
  });
  routerRef.current = router;

  function setAdapters(next: readonly NotificationAdapter[]): void {
    const ids = next.map((adapter) => adapter.id);
    if (ids.some((id) => !id.trim())) {
      throw new Error("Notification adapter ids must not be empty");
    }
    if (new Set(ids).size !== ids.length) {
      throw new Error("Notification adapter ids must be unique");
    }
    adapters = next;
    adapterMap = new Map(next.map((adapter) => [adapter.id, adapter]));
    router.setAdapters(next);
  }

  async function notify(
    notification: Notification,
    options: { extraTargets?: readonly NotificationTarget[] } = {}
  ) {
    return router.notify(notification, options);
  }

  async function notifyInput(
    value: unknown
  ): Promise<NotificationDispatchOutcome> {
    const notification = parseNotification(value, {
      now: now(),
      newId: () => `notification-${randomUUID()}`,
    });
    const result = await notify(notification);
    return { notification, ...result };
  }

  async function test(targetId: string) {
    const result = await router.test(targetId);
    if (!result.found) return result;
    return {
      found: true as const,
      targetId: result.target.id,
      attempt: result.attempt,
    };
  }

  async function settingsView(): Promise<NotificationSettings> {
    return redactNotificationSettings(await settings.get());
  }

  async function updateSettings(value: unknown): Promise<NotificationSettings> {
    const restored = restoreRedactedSecrets(value, await settings.get());
    return redactNotificationSettings(await settings.set(restored));
  }

  async function status(): Promise<NotificationStatus> {
    const [current, digestPending] = await Promise.all([
      router.status(),
      digest.pending(),
    ]);
    const byTarget = new Map(
      digestPending.map((entry) => [entry.targetId, entry.count])
    );
    return {
      ...current,
      targets: current.targets.map((target) => {
        const count = byTarget.get(target.targetId);
        return count === undefined
          ? target
          : { ...target, digestPending: count };
      }),
    };
  }

  async function flush(): Promise<void> {
    await digest.flushDue();
    await router.flush();
  }

  return {
    notify,
    notifyInput,
    test,
    status,
    setAdapters,
    channels: () => notificationChannels(adapters),
    settings: settingsView,
    updateSettings,
    flush,
    start: () => {
      digest.start();
      router.start();
    },
    stop: async () => {
      await digest.stop();
      await router.stop();
    },
  };
}

export type NotificationDispatchOutcome = {
  notification: Notification;
  id: string;
  targets: string[];
  skipped: number;
};

export type {
  Notification,
  NotificationAdapter,
  NotificationDeliveryAttempt,
  NotificationTarget,
};

/**
 * A settings round-trip from a client reads masked values, then writes them back. Replace a masked
 * address field with the current secret so editing an unrelated field does not erase a credential. A
 * masked URL query value is restored by name; a whole masked field is restored by key.
 */
function restoreRedactedSecrets(
  value: unknown,
  current: NotificationSettings
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  let copy: Record<string, unknown>;
  try {
    copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return value;
  }
  if (!Array.isArray(copy.targets)) return copy;
  for (const target of copy.targets) {
    if (!target || typeof target !== "object" || Array.isArray(target))
      continue;
    const row = target as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : undefined;
    const existing = id
      ? current.targets.find((candidate) => candidate.id === id)
      : undefined;
    if (!existing) continue;
    const channel = row.channel;
    if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
      continue;
    }
    const address = (channel as Record<string, unknown>).address;
    if (!address || typeof address !== "object" || Array.isArray(address)) {
      continue;
    }
    const incoming = address as Record<string, unknown>;
    for (const [key, saved] of Object.entries(existing.channel.address ?? {})) {
      if (incoming[key] === "***REDACTED***") {
        incoming[key] = saved;
      } else if (
        typeof incoming[key] === "string" &&
        /^https?:\/\//i.test(incoming[key])
      ) {
        incoming[key] = restoreUrl(incoming[key], saved);
      }
    }
  }
  return copy;
}

function restoreUrl(incoming: string, saved: string): string {
  let next: URL;
  let previous: URL;
  try {
    next = new URL(incoming);
    previous = new URL(saved);
  } catch {
    return incoming;
  }
  // Never move a stored secret to a different endpoint: the person may have repointed the target.
  if (next.origin !== previous.origin || next.pathname !== previous.pathname) {
    return incoming;
  }
  for (const key of next.searchParams.keys()) {
    if (next.searchParams.get(key) !== "***REDACTED***") continue;
    const secret = previous.searchParams.get(key);
    if (secret !== null) next.searchParams.set(key, secret);
  }
  return next.toString();
}
