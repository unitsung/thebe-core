import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { redactToolOutput } from "../security/redaction.ts";
import { key } from "../tickets/ids.ts";
import type { ChannelRef } from "../sources/types.ts";
import { channelIdentity } from "./delivery.ts";
import type {
  Notification,
  NotificationDeliveryAttempt,
  NotificationOutboxStatus,
  NotificationTarget,
} from "./types.ts";

export const DEFAULT_NOTIFICATION_POLL_MS = 5_000;
const DEFAULT_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
const MAX_FINISHED = 1_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const LEASE_MS = 60_000;
const OUTBOX_FILE = "outbox.json";

type EntryState = "claimed" | "send_started";

export type NotificationOutboxEntry = {
  /** `<targetId>|<notificationId>` hashed: one logical notice per target. */
  id: string;
  targetId: string;
  /** The full target is stored so a Ticket channel discovered at event time survives a restart. */
  target: NotificationTarget;
  channel: ChannelRef;
  notification: Notification;
  state: EntryState;
  attemptId?: string;
  leaseUntil?: string;
  createdAt: string;
  nextAttemptAt: string;
  attempts: number;
  lastError?: string;
  /** When the last failed attempt finished, for status; distinct from the next attempt time. */
  lastFailureAt?: string;
};

export type FinishedNotification = {
  id: string;
  targetId: string;
  notificationId: string;
  outcome: "delivered" | "dropped" | "unknown";
  reason?: string;
  at: string;
};

type StoredEntry = NotificationOutboxEntry;

type OutboxState = {
  version: 1;
  entries: StoredEntry[];
  finished: FinishedNotification[];
};

export type NotificationOutboxSend = (input: {
  targetId: string;
  target: NotificationTarget;
  channel: ChannelRef;
  notification: Notification;
  idempotencyKey: string;
}) => Promise<NotificationDeliveryAttempt>;

export type NotificationOutbox = ReturnType<typeof createNotificationOutbox>;

/**
 * Durable, at-least-once delivery for person-facing notices. One queue per target preserves the order
 * the caller enqueued; a retry keeps the same idempotency key and sequence. A send interrupted by a
 * restart is recorded as `unknown` and is never replayed: a notice that may already be on a phone must
 * not appear twice.
 */
export function createNotificationOutbox(options: {
  dir?: string;
  send: NotificationOutboxSend;
  now?: () => Date;
  retryBaseMs?: number;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}): {
  enqueue(
    entries: readonly {
      target: NotificationTarget;
      notification: Notification;
      /** Delay delivery until this instant (quiet hours). */
      notBefore?: Date;
    }[]
  ): Promise<void>;
  flush(): Promise<Map<string, NotificationDeliveryAttempt>>;
  pending(): Promise<NotificationOutboxEntry[]>;
  /** Whether this exact notice is already queued or has finished for this target. */
  has(targetId: string, notificationId: string): Promise<boolean>;
  recordDropped(input: {
    targetId: string;
    notificationId: string;
    reason: string;
  }): Promise<void>;
  status(targetId?: string): NotificationOutboxStatus;
  start(): void;
  stop(): Promise<void>;
} {
  const now = options.now ?? (() => new Date());
  const baseMs = positive(options.retryBaseMs, DEFAULT_RETRY_MS);
  const pollMs = positive(options.pollIntervalMs, DEFAULT_NOTIFICATION_POLL_MS);
  const file = options.dir ? join(options.dir, OUTBOX_FILE) : undefined;
  let state: OutboxState | undefined;
  let loading: Promise<void> | undefined;
  let chain = Promise.resolve();
  let flushing: Promise<Map<string, NotificationDeliveryAttempt>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = true;
  const running = new Set<string>();

  async function load(): Promise<void> {
    if (state) return;
    if (!file) {
      state = { version: 1, entries: [], finished: [] };
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      state = parseState(parsed, now());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        state = { version: 1, entries: [], finished: [] };
        return;
      }
      throw error;
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (state) return;
    loading ??= load();
    await loading;
  }

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = chain.then(async () => {
      await ensureLoaded();
      return operation();
    });
    chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function persist(): Promise<void> {
    if (!file || !state) return;
    await mkdir(options.dir!, { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  function finish(
    entry: NotificationOutboxEntry,
    outcome: FinishedNotification["outcome"],
    reason?: string
  ): void {
    state!.entries = state!.entries.filter((row) => row.id !== entry.id);
    state!.finished.push({
      id: entry.id,
      targetId: entry.targetId,
      notificationId: entry.notification.id,
      outcome,
      ...(reason ? { reason: safeReason(reason) } : {}),
      at: now().toISOString(),
    });
    pruneFinished(state!);
  }

  function pruneFinished(current: OutboxState): void {
    const cutoff = now().getTime() - RETENTION_MS;
    current.finished = current.finished
      .filter((row) => Date.parse(row.at) >= cutoff)
      .slice(-MAX_FINISHED);
  }

  async function enqueue(
    entries: readonly {
      target: NotificationTarget;
      notification: Notification;
      notBefore?: Date;
    }[]
  ): Promise<void> {
    await serial(async () => {
      const known = new Set(state!.entries.map((entry) => entry.id));
      const finishedIds = new Set(state!.finished.map((row) => row.id));
      let changed = false;
      for (const item of entries) {
        const id = key(
          "notification-outbox",
          item.target.id,
          item.notification.id
        );
        if (known.has(id) || finishedIds.has(id)) continue;
        const at = now().toISOString();
        const notBefore = item.notBefore
          ? new Date(Math.max(item.notBefore.getTime(), now().getTime()))
          : now();
        state!.entries.push({
          id,
          targetId: item.target.id,
          target: cloneTarget(item.target),
          channel: cloneChannel(item.target.channel),
          notification: cloneNotification(item.notification),
          state: "claimed",
          createdAt: at,
          nextAttemptAt: notBefore.toISOString(),
          attempts: 0,
        });
        known.add(id);
        changed = true;
      }
      if (changed) await persist();
    });
  }

  async function flush(): Promise<Map<string, NotificationDeliveryAttempt>> {
    if (!active) return new Map();
    if (flushing) return flushing;
    flushing = (async () => {
      const outcomes = new Map<string, NotificationDeliveryAttempt>();
      while (true) {
        const due = await serial(async () =>
          dueHeads(state!, now())
            .filter((entry) => !running.has(entry.targetId))
            .map(cloneEntry)
        );
        if (due.length === 0) return outcomes;
        await Promise.all(
          due.map(async (entry) => {
            running.add(entry.targetId);
            try {
              const attempt = await deliver(entry);
              outcomes.set(entry.id, attempt);
            } finally {
              running.delete(entry.targetId);
            }
          })
        );
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }

  async function deliver(
    entry: NotificationOutboxEntry
  ): Promise<NotificationDeliveryAttempt> {
    const attemptId = randomUUID();
    await serial(async () => {
      const current = state!.entries.find((row) => row.id === entry.id);
      if (!current || current.state !== "claimed") return;
      current.state = "send_started";
      current.attemptId = attemptId;
      current.leaseUntil = new Date(now().getTime() + LEASE_MS).toISOString();
      await persist();
    });
    let attempt: NotificationDeliveryAttempt;
    try {
      attempt = await options.send({
        targetId: entry.targetId,
        target: cloneTarget(entry.target),
        channel: cloneChannel(entry.channel),
        notification: cloneNotification(entry.notification),
        idempotencyKey: entry.id,
      });
    } catch (error) {
      attempt = {
        status: "retry",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    await serial(async () => {
      const current = state!.entries.find((row) => row.id === entry.id);
      if (!current || current.attemptId !== attemptId) return;
      current.leaseUntil = undefined;
      if (attempt.status === "sent") {
        current.state = "claimed";
        finish(current, "delivered");
      } else if (attempt.status === "discard") {
        current.state = "claimed";
        finish(current, "dropped", attempt.reason);
      } else if (attempt.status === "unknown") {
        current.state = "claimed";
        finish(current, "unknown", attempt.reason);
      } else {
        current.state = "claimed";
        current.attempts += 1;
        current.lastError = safeReason(attempt.reason);
        current.lastFailureAt = now().toISOString();
        current.nextAttemptAt = new Date(
          now().getTime() +
            (attempt.retryAfterMs && attempt.retryAfterMs > 0
              ? Math.min(MAX_RETRY_MS, attempt.retryAfterMs)
              : retryDelay(baseMs, current.attempts))
        ).toISOString();
      }
      await persist();
    });
    return attempt;
  }

  async function recordDropped(input: {
    targetId: string;
    notificationId: string;
    reason: string;
  }): Promise<void> {
    await serial(async () => {
      state!.finished.push({
        id: key("notification-outbox", input.targetId, input.notificationId),
        targetId: input.targetId,
        notificationId: input.notificationId,
        outcome: "dropped",
        reason: safeReason(input.reason),
        at: now().toISOString(),
      });
      pruneFinished(state!);
      await persist();
    });
  }

  function status(targetId?: string): NotificationOutboxStatus {
    if (!state) {
      return { pending: 0, dropped: 0, unknown: 0 };
    }
    const scoped = targetId
      ? state.finished.filter((row) => row.targetId === targetId)
      : state.finished;
    const pending = state.entries.filter(
      (entry) => !targetId || entry.targetId === targetId
    );
    const dropped = scoped.filter((row) => row.outcome === "dropped");
    const unknown = scoped.filter((row) => row.outcome === "unknown");
    const delivered = scoped.filter((row) => row.outcome === "delivered");
    const lastSent = delivered.at(-1);
    const lastDrop = dropped.at(-1);
    const failed = pending.filter((entry) => entry.lastError);
    const lastFailed = failed.at(-1);
    const lastError = lastFailed?.lastError ?? lastDrop?.reason;
    const lastFailureAt = lastFailed?.lastFailureAt ?? lastDrop?.at;
    return {
      pending: pending.length,
      dropped: dropped.length,
      unknown: unknown.length,
      ...(lastSent ? { lastSentAt: lastSent.at } : {}),
      ...(lastError ? { lastError: safeReason(lastError) } : {}),
      ...(lastFailureAt ? { lastFailureAt } : {}),
      ...(lastDrop
        ? {
            lastDrop: {
              id: lastDrop.notificationId,
              reason: lastDrop.reason ?? "dropped",
              at: lastDrop.at,
            },
          }
        : {}),
    };
  }

  function start(): void {
    active = true;
    if (timer) return;
    timer = setInterval(() => {
      void flush().catch((error) => options.onError?.(error));
    }, pollMs);
    timer.unref?.();
    void flush().catch((error) => options.onError?.(error));
  }

  async function stop(): Promise<void> {
    active = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    await flushing?.then(
      () => undefined,
      () => undefined
    );
    await chain.catch(() => undefined);
  }

  async function pending(): Promise<NotificationOutboxEntry[]> {
    return serial(async () => state!.entries.map(cloneEntry));
  }

  async function has(
    targetId: string,
    notificationId: string
  ): Promise<boolean> {
    return serial(async () => {
      const id = key("notification-outbox", targetId, notificationId);
      return (
        state!.entries.some((entry) => entry.id === id) ||
        state!.finished.some((row) => row.id === id)
      );
    });
  }

  return {
    enqueue,
    flush,
    pending,
    has,
    recordDropped,
    status,
    start,
    stop,
  };
}

function dueHeads(state: OutboxState, now: Date): NotificationOutboxEntry[] {
  const blocked = new Set<string>();
  const heldForQuiet = new Set<string>();
  const heads: NotificationOutboxEntry[] = [];
  const nowMs = now.getTime();
  for (const entry of state.entries) {
    const { ticketId, goalId } = entry.notification;
    const ticketChannel =
      ticketId && goalId
        ? key(
            "ticket-notification-channel",
            ticketId,
            channelIdentity(entry.channel)
          )
        : undefined;
    if (ticketChannel && blocked.has(ticketChannel)) continue;
    if (blocked.has(entry.targetId)) continue;
    if (ticketChannel) blocked.add(ticketChannel);
    if (entry.state === "send_started") {
      blocked.add(entry.targetId);
      continue;
    }
    if (Date.parse(entry.nextAttemptAt) > nowMs) {
      // A notice waiting for quiet hours does not hold back a critical notice behind it. A retry does:
      // the target's older notice must settle before a newer one, or order and dedupe get confusing.
      if (entry.attempts === 0 && !entry.lastError) {
        heldForQuiet.add(entry.targetId);
      } else {
        blocked.add(entry.targetId);
      }
      continue;
    }
    if (
      heldForQuiet.has(entry.targetId) &&
      entry.notification.priority !== "critical"
    ) {
      blocked.add(entry.targetId);
      continue;
    }
    heads.push(entry);
    blocked.add(entry.targetId);
  }
  return heads;
}

function parseState(value: unknown, now: Date): OutboxState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Notification outbox is malformed");
  }
  const input = value as Partial<OutboxState>;
  if (input.version !== 1 || !Array.isArray(input.entries)) {
    throw new Error("Notification outbox has an unsupported version");
  }
  const state: OutboxState = {
    version: 1,
    entries: [],
    finished: Array.isArray(input.finished)
      ? input.finished.filter(isFinished)
      : [],
  };
  for (const row of input.entries) {
    // A file written before targets were stored alongside the entry: rebuild the minimal target from
    // the channel so an upgrade does not lose a queued notice.
    if (
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      !("target" in row) &&
      isChannel((row as Partial<NotificationOutboxEntry>).channel)
    ) {
      const legacy = row as Partial<NotificationOutboxEntry>;
      (row as Record<string, unknown>).target = {
        id: legacy.targetId,
        channel: legacy.channel,
        categories: "all",
        enabled: true,
      };
    }
    if (!isStoredEntry(row)) {
      throw new Error("Notification outbox contains an invalid entry");
    }
    if (row.state === "send_started") {
      // The process stopped while the adapter was sending. The platform may have accepted it; replaying
      // would duplicate the notification, so settle it as unknown.
      state.finished.push({
        id: row.id,
        targetId: row.targetId,
        notificationId: row.notification.id,
        outcome: "unknown",
        reason: "Core restarted while the notice was being sent",
        at: now.toISOString(),
      });
      continue;
    }
    state.entries.push({
      ...cloneEntry(row),
      leaseUntil: undefined,
      attemptId: undefined,
    });
  }
  pruneFinishedAt(state, now);
  return state;
}

function pruneFinishedAt(state: OutboxState, now: Date): void {
  const cutoff = now.getTime() - RETENTION_MS;
  state.finished = state.finished
    .filter((row) => Date.parse(row.at) >= cutoff)
    .slice(-MAX_FINISHED);
}

function isStoredEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<StoredEntry>;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.targetId === "string" &&
    row.targetId.length > 0 &&
    isTarget(row.target) &&
    isChannel(row.channel) &&
    isNotification(row.notification) &&
    (row.state === "claimed" || row.state === "send_started") &&
    typeof row.createdAt === "string" &&
    typeof row.nextAttemptAt === "string" &&
    typeof row.attempts === "number" &&
    Number.isSafeInteger(row.attempts) &&
    row.attempts >= 0 &&
    (row.lastError === undefined || typeof row.lastError === "string") &&
    (row.lastFailureAt === undefined || typeof row.lastFailureAt === "string")
  );
}

function isFinished(value: unknown): value is FinishedNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<FinishedNotification>;
  return (
    typeof row.id === "string" &&
    typeof row.targetId === "string" &&
    typeof row.notificationId === "string" &&
    (row.outcome === "delivered" ||
      row.outcome === "dropped" ||
      row.outcome === "unknown") &&
    typeof row.at === "string" &&
    (row.reason === undefined || typeof row.reason === "string")
  );
}

function isTarget(value: unknown): value is NotificationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Partial<NotificationTarget>;
  return (
    typeof target.id === "string" &&
    target.id.length > 0 &&
    isChannel(target.channel) &&
    (target.categories === "all" ||
      (Array.isArray(target.categories) &&
        target.categories.every((item) => typeof item === "string"))) &&
    typeof target.enabled === "boolean"
  );
}

function isChannel(value: unknown): value is ChannelRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const channel = value as Partial<ChannelRef>;
  return (
    typeof channel.source === "string" &&
    channel.source.length > 0 &&
    typeof channel.thread === "string" &&
    channel.thread.length > 0 &&
    (channel.address === undefined ||
      (typeof channel.address === "object" &&
        !Array.isArray(channel.address) &&
        Object.values(channel.address).every(
          (item) => typeof item === "string"
        )))
  );
}

function isNotification(value: unknown): value is Notification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Notification>;
  return (
    typeof row.id === "string" &&
    typeof row.title === "string" &&
    typeof row.body === "string" &&
    typeof row.category === "string" &&
    typeof row.priority === "string" &&
    typeof row.createdAt === "string"
  );
}

function cloneEntry(entry: NotificationOutboxEntry): NotificationOutboxEntry {
  return {
    ...entry,
    target: cloneTarget(entry.target),
    channel: cloneChannel(entry.channel),
    notification: cloneNotification(entry.notification),
  };
}

function cloneTarget(target: NotificationTarget): NotificationTarget {
  return {
    ...target,
    channel: cloneChannel(target.channel),
    ...(target.categories === "all"
      ? {}
      : { categories: [...target.categories] }),
    ...(target.quietHours ? { quietHours: { ...target.quietHours } } : {}),
    ...(target.digest
      ? {
          digest: {
            ...target.digest,
            categories: [...target.digest.categories],
          },
        }
      : {}),
  };
}

function cloneChannel(channel: ChannelRef): ChannelRef {
  return {
    source: channel.source,
    thread: channel.thread,
    ...(channel.address ? { address: { ...channel.address } } : {}),
  };
}

function cloneNotification(notification: Notification): Notification {
  return {
    ...notification,
    ...(notification.resource
      ? { resource: { ...notification.resource } }
      : {}),
  };
}

function retryDelay(baseMs: number, attempts: number): number {
  return Math.min(MAX_RETRY_MS, baseMs * 2 ** Math.min(attempts - 1, 16));
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0
    ? Math.floor(value as number)
    : fallback;
}

function safeReason(reason: string): string {
  return redactToolOutput(reason).slice(0, 500);
}
