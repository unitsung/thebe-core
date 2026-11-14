import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { key } from "../tickets/ids.ts";
import type { Notification, NotificationTarget } from "./types.ts";

const DIGEST_FILE = "digests.json";
const MAX_NOTIFICATIONS_PER_WINDOW = 50;
const MAX_FINISHED_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export type NotificationDigestEntry = {
  targetId: string;
  target: NotificationTarget;
  /** First notice in the window; also the stable part of the summary id. */
  windowStartedAt: string;
  windowEndsAt: string;
  notifications: Notification[];
};

type DigestState = {
  version: 1;
  entries: NotificationDigestEntry[];
};

export type NotificationDigest = ReturnType<typeof createNotificationDigest>;

/**
 * Accumulates low/normal notices per target for a fixed window and emits one summary when it ends.
 * Critical notices never enter here. The state is durable, so a restart during the window keeps the
 * notices, and a window that ended while Core was down is emitted at start.
 */
export function createNotificationDigest(options: {
  dir?: string;
  now?: () => Date;
  emit: (
    target: NotificationTarget,
    notification: Notification
  ) => Promise<void>;
  onError?: (error: unknown) => void;
}): {
  canDigest(target: NotificationTarget, notification: Notification): boolean;
  add(target: NotificationTarget, notification: Notification): Promise<boolean>;
  flushDue(): Promise<void>;
  pending(): Promise<
    Array<{ targetId: string; count: number; windowEndsAt: string }>
  >;
  start(): void;
  stop(): Promise<void>;
} {
  const now = options.now ?? (() => new Date());
  const file = options.dir ? join(options.dir, DIGEST_FILE) : undefined;
  let state: DigestState | undefined;
  let loading: Promise<void> | undefined;
  let chain = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;

  async function load(): Promise<void> {
    if (state) return;
    if (!file) {
      state = { version: 1, entries: [] };
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      state = parseState(parsed, now());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        state = { version: 1, entries: [] };
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
    await writeFileAtomic(file, `${JSON.stringify(state)}\n`, "utf8");
  }

  function canDigest(
    target: NotificationTarget,
    notification: Notification
  ): boolean {
    const digest = target.digest;
    if (!digest) return false;
    if (notification.priority === "critical") return false;
    return digest.categories.includes(notification.category);
  }

  async function add(
    target: NotificationTarget,
    notification: Notification
  ): Promise<boolean> {
    if (!canDigest(target, notification)) return false;
    await flushDue();
    const accepted = await serial(async () => {
      const end = now().getTime() + windowMs(target);
      let entry = state!.entries.find((row) => row.targetId === target.id);
      if (entry && Date.parse(entry.windowEndsAt) <= now().getTime()) {
        state!.entries = state!.entries.filter((row) => row !== entry);
        entry = undefined;
      }
      if (!entry) {
        entry = {
          targetId: target.id,
          target: cloneTarget(target),
          windowStartedAt: now().toISOString(),
          windowEndsAt: new Date(end).toISOString(),
          notifications: [],
        };
        state!.entries.push(entry);
      }
      if (entry.notifications.some((row) => row.id === notification.id)) {
        return true;
      }
      entry.target = cloneTarget(target);
      entry.notifications.push(cloneNotification(notification));
      if (entry.notifications.length > MAX_NOTIFICATIONS_PER_WINDOW) {
        entry.notifications.splice(
          0,
          entry.notifications.length - MAX_NOTIFICATIONS_PER_WINDOW
        );
      }
      await persist();
      return true;
    });
    if (accepted) arm();
    return accepted;
  }

  async function flushDue(): Promise<void> {
    if (!active) return;
    const due = await serial(async () => {
      const nowMs = now().getTime();
      const dueEntries = state!.entries.filter(
        (entry) => Date.parse(entry.windowEndsAt) <= nowMs
      );
      return dueEntries.map(cloneEntry);
    });
    for (const entry of due) {
      const summary = summarize(entry, now());
      try {
        await options.emit(entry.target, summary);
      } catch (error) {
        options.onError?.(error);
        continue;
      }
      await serial(async () => {
        state!.entries = state!.entries.filter(
          (row) => row.targetId !== entry.targetId
        );
        await persist();
      });
    }
    arm();
  }

  function arm(): void {
    if (!active || !state) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    let nextAt: number | undefined;
    for (const entry of state.entries) {
      const at = Date.parse(entry.windowEndsAt);
      if (Number.isFinite(at)) nextAt = Math.min(nextAt ?? Infinity, at);
    }
    if (nextAt === undefined) return;
    timer = setTimeout(
      () => void flushDue().catch((error) => options.onError?.(error)),
      Math.max(0, nextAt - now().getTime())
    );
    timer.unref?.();
  }

  function start(): void {
    active = true;
    void serial(async () => {
      const cutoff = now().getTime() - MAX_FINISHED_AGE_MS;
      state!.entries = state!.entries.filter(
        (entry) => Date.parse(entry.windowEndsAt) >= cutoff
      );
      await persist();
    })
      .then(() => flushDue())
      .catch((error) => options.onError?.(error));
  }

  async function stop(): Promise<void> {
    active = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    await chain.catch(() => undefined);
  }

  async function pending(): Promise<
    Array<{ targetId: string; count: number; windowEndsAt: string }>
  > {
    return serial(async () =>
      state!.entries.map((entry) => ({
        targetId: entry.targetId,
        count: entry.notifications.length,
        windowEndsAt: entry.windowEndsAt,
      }))
    );
  }

  return {
    canDigest,
    add,
    flushDue,
    pending,
    start,
    stop,
  };
}

function windowMs(target: NotificationTarget): number {
  return Math.max(1, target.digest?.windowMinutes ?? 1) * 60_000;
}

function summarize(entry: NotificationDigestEntry, at: Date): Notification {
  const count = entry.notifications.length;
  const lines = entry.notifications
    .slice(-8)
    .map((notification) => `• ${truncate(notification.title, 80)}`)
    .join("\n");
  const first = entry.notifications[0];
  return {
    id: key("notification-digest", entry.targetId, entry.windowStartedAt),
    category: first?.category ?? "attention",
    priority: "normal",
    title: `Thebe: ${count} update${count === 1 ? "" : "s"}`,
    body:
      count > 8
        ? `${lines}\n…and ${count - 8} more`
        : lines || "Thebe has an update.",
    deepLink: "thebe://core",
    createdAt: at.toISOString(),
  };
}

function parseState(value: unknown, now: Date): DigestState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Notification digest is malformed");
  }
  const input = value as Partial<DigestState>;
  if (input.version !== 1 || !Array.isArray(input.entries)) {
    throw new Error("Notification digest has an unsupported version");
  }
  const cutoff = now.getTime() - MAX_FINISHED_AGE_MS;
  const entries: NotificationDigestEntry[] = [];
  for (const row of input.entries) {
    if (!isEntry(row)) {
      throw new Error("Notification digest contains an invalid entry");
    }
    if (Date.parse(row.windowEndsAt) < cutoff) continue;
    entries.push(cloneEntry(row));
  }
  return { version: 1, entries };
}

function isEntry(value: unknown): value is NotificationDigestEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<NotificationDigestEntry>;
  return (
    typeof row.targetId === "string" &&
    row.targetId.length > 0 &&
    isTarget(row.target) &&
    typeof row.windowStartedAt === "string" &&
    Number.isFinite(Date.parse(row.windowStartedAt)) &&
    typeof row.windowEndsAt === "string" &&
    Number.isFinite(Date.parse(row.windowEndsAt)) &&
    Array.isArray(row.notifications) &&
    row.notifications.every(isNotification)
  );
}

function isTarget(value: unknown): value is NotificationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Partial<NotificationTarget>;
  return (
    typeof target.id === "string" &&
    target.id.length > 0 &&
    !!target.channel &&
    typeof target.channel.source === "string" &&
    typeof target.channel.thread === "string" &&
    (target.categories === "all" || Array.isArray(target.categories)) &&
    typeof target.enabled === "boolean"
  );
}

function isNotification(value: unknown): value is Notification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Notification>;
  return (
    typeof row.id === "string" &&
    typeof row.category === "string" &&
    typeof row.priority === "string" &&
    typeof row.title === "string" &&
    typeof row.body === "string" &&
    typeof row.createdAt === "string"
  );
}

function cloneEntry(entry: NotificationDigestEntry): NotificationDigestEntry {
  return {
    targetId: entry.targetId,
    target: cloneTarget(entry.target),
    windowStartedAt: entry.windowStartedAt,
    windowEndsAt: entry.windowEndsAt,
    notifications: entry.notifications.map(cloneNotification),
  };
}

function cloneTarget(target: NotificationTarget): NotificationTarget {
  return {
    ...target,
    channel: {
      ...target.channel,
      ...(target.channel.address
        ? { address: { ...target.channel.address } }
        : {}),
    },
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

function cloneNotification(notification: Notification): Notification {
  return {
    ...notification,
    ...(notification.resource
      ? { resource: { ...notification.resource } }
      : {}),
  };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
