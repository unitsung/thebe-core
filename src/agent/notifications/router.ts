import { randomUUID } from "node:crypto";
import { isQuiet, msUntilQuietEnds } from "./quiet-hours.ts";
import type { ChannelRef } from "../sources/types.ts";
import { deliverToAdapters } from "./delivery.ts";
import type { NotificationDigest } from "./digest.ts";
import type { NotificationOutbox } from "./outbox.ts";
import type { NotificationSettingsStore } from "./settings.ts";
import {
  noticePriorityRank,
  type Notification,
  type NotificationAdapter,
  type NotificationDeliveryAttempt,
  type NotificationSettings,
  type NotificationStatus,
  type NotificationTarget,
  type NotificationTargetStatus,
} from "./types.ts";

export type NotificationDispatchResult = {
  id: string;
  /** Target ids that accepted the notice into their queue. */
  targets: string[];
  /** Targets skipped because the category, priority, or rate limit excluded them. */
  skipped: number;
};

/**
 * Selects destinations from settings and queues one entry per target. Delivery itself is the outbox's
 * job; a slow or broken adapter never blocks another target.
 */
export function createNotificationRouter(options: {
  settings: NotificationSettingsStore;
  outbox: NotificationOutbox;
  adapters: readonly NotificationAdapter[];
  digest?: NotificationDigest;
  now?: () => Date;
  onError?: (error: unknown) => void;
}) {
  const now = options.now ?? (() => new Date());
  let adapters = adapterMap(options.adapters);
  const rateWindows = new Map<string, number[]>();

  async function notify(
    notification: Notification,
    dispatch: {
      extraTargets?: readonly NotificationTarget[];
      /** A digest summary must not be accumulated into another digest. */
      skipDigest?: boolean;
    } = {}
  ): Promise<NotificationDispatchResult> {
    const settings = await options.settings.get();
    const targets = selectTargets(
      settings,
      notification,
      dispatch.extraTargets
    );
    if (targets.length === 0) {
      return { id: notification.id, targets: [], skipped: 0 };
    }
    const accepted: NotificationTarget[] = [];
    const immediate: NotificationTarget[] = [];
    let skipped = 0;
    const seenChannels = new Set<string>();
    for (const target of targets) {
      const channelKey = channelIdentity(target.channel);
      if (seenChannels.has(channelKey)) {
        skipped += 1;
        continue;
      }
      seenChannels.add(channelKey);
      const adapter = adapters.get(target.channel.source);
      if (!adapter) {
        skipped += 1;
        await options.outbox.recordDropped({
          targetId: target.id,
          notificationId: notification.id,
          reason: `adapter_missing:${target.channel.source}`,
        });
        continue;
      }
      const known = await options.outbox.has(target.id, notification.id);
      if (known) {
        accepted.push(target);
        continue;
      }
      if (
        !dispatch.skipDigest &&
        options.digest?.canDigest(target, notification)
      ) {
        await options.digest.add(target, notification);
        accepted.push(target);
        continue;
      }
      if (!rateAllows(settings, target, notification)) {
        skipped += 1;
        await options.outbox.recordDropped({
          targetId: target.id,
          notificationId: notification.id,
          reason: "rate_limited",
        });
        continue;
      }
      accepted.push(target);
      immediate.push(target);
    }
    const quietTargets = immediate.map((target) => ({
      target,
      notBefore: quietEnd(settings, target, notification, now()),
    }));
    await options.outbox.enqueue(
      quietTargets.map(({ target, notBefore }) => ({
        target,
        notification,
        ...(notBefore ? { notBefore } : {}),
      }))
    );
    if (immediate.length > 0) {
      void options.outbox.flush().catch((error) => options.onError?.(error));
    }
    return {
      id: notification.id,
      targets: accepted.map((target) => target.id),
      skipped,
    };
  }

  /** Sends a test notice immediately, outside the queue, so the settings page gets a real answer. */
  async function test(targetId: string): Promise<
    | {
        found: true;
        target: NotificationTarget;
        attempt: NotificationDeliveryAttempt;
      }
    | { found: false }
  > {
    const settings = await options.settings.get();
    const target = settings.targets.find((row) => row.id === targetId);
    if (!target) return { found: false };
    const adapter = adapters.get(target.channel.source);
    if (!adapter) {
      return {
        found: true,
        target,
        attempt: {
          status: "discard",
          reason: `adapter_missing:${target.channel.source}`,
        },
      };
    }
    const notification: Notification = {
      id: `notification-test-${randomUUID()}`,
      category: "pipeline",
      priority: "normal",
      title: "Thebe notification test",
      body: "If you can read this, this notification target works.",
      deepLink: "thebe://core",
      createdAt: now().toISOString(),
    };
    return {
      found: true,
      target,
      attempt: await deliverToAdapters(adapters, {
        target,
        notification,
        idempotencyKey: notification.id,
      }),
    };
  }

  async function status(): Promise<NotificationStatus> {
    // Loading the outbox is what makes its in-memory status truthful after a restart.
    await options.outbox.pending();
    const settings = await options.settings.get();
    const targets: NotificationTargetStatus[] = settings.targets.map(
      (target) => ({
        targetId: target.id,
        ...(target.label ? { label: target.label } : {}),
        enabled: target.enabled,
        ...options.outbox.status(target.id),
      })
    );
    const total = options.outbox.status();
    return {
      pending: total.pending,
      dropped: total.dropped,
      unknown: total.unknown,
      ...(total.lastError ? { lastError: total.lastError } : {}),
      ...(total.lastFailureAt ? { lastFailureAt: total.lastFailureAt } : {}),
      targets,
    };
  }

  function isEnabledTarget(
    target: NotificationTarget,
    notification: Notification
  ): boolean {
    if (!target.enabled) return false;
    if (
      target.categories !== "all" &&
      !target.categories.includes(notification.category)
    ) {
      return false;
    }
    const minimum = target.minPriority ?? "low";
    return (
      noticePriorityRank(notification.priority) >= noticePriorityRank(minimum)
    );
  }

  function selectTargets(
    settings: NotificationSettings,
    notification: Notification,
    extraTargets: readonly NotificationTarget[] = []
  ): NotificationTarget[] {
    const byId = new Map<string, NotificationTarget>();
    for (const target of settings.targets) byId.set(target.id, target);
    for (const target of extraTargets) {
      if (!byId.has(target.id)) byId.set(target.id, target);
    }
    return [...byId.values()].filter((target) =>
      isEnabledTarget(target, notification)
    );
  }

  function setAdapters(next: readonly NotificationAdapter[]): void {
    adapters = adapterMap(next);
  }

  function rateAllows(
    settings: NotificationSettings,
    target: NotificationTarget,
    notification: Notification
  ): boolean {
    const limit = settings.rateLimitPerHour;
    if (limit <= 0 || notification.priority === "critical") return true;
    const at = now().getTime();
    const window = rateWindows.get(target.id) ?? [];
    const recent = window.filter((entry) => entry > at - 60 * 60 * 1_000);
    if (recent.length >= limit) {
      rateWindows.set(target.id, recent);
      return false;
    }
    recent.push(at);
    rateWindows.set(target.id, recent);
    return true;
  }

  function quietEnd(
    settings: NotificationSettings,
    target: NotificationTarget,
    notification: Notification,
    at: Date
  ): Date | undefined {
    const window = target.quietHours ?? settings.defaultQuietHours;
    if (!window || !isQuiet(window, at)) return undefined;
    if (
      notification.priority === "critical" &&
      settings.criticalBypassesQuietHours
    ) {
      return undefined;
    }
    return new Date(at.getTime() + msUntilQuietEnds(window, at));
  }

  return {
    notify,
    test,
    status,
    setAdapters,
    flush: () => options.outbox.flush(),
    start: () => options.outbox.start(),
    stop: () => options.outbox.stop(),
  };
}

function channelIdentity(channel: ChannelRef): string {
  const address = Object.entries(channel.address ?? {}).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  return JSON.stringify([channel.source, channel.thread, address]);
}

function adapterMap(
  adapters: readonly NotificationAdapter[]
): Map<string, NotificationAdapter> {
  const ids = adapters.map((adapter) => adapter.id);
  if (ids.some((id) => !id.trim())) {
    throw new Error("Notification adapter ids must not be empty");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("Notification adapter ids must be unique");
  }
  return new Map(adapters.map((adapter) => [adapter.id, adapter]));
}
