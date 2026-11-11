import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import type { ChannelRef } from "../sources/types.ts";
import type { TicketChannelNotice } from "./types.ts";

export const DEFAULT_CHANNEL_OUTBOX_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

export type QueuedChannelNotice = {
  id: string;
  channel: ChannelRef;
  notice: TicketChannelNotice;
};

export type ChannelDeliveryAttempt =
  | { status: "sent" }
  | { status: "discard" }
  | { status: "retry"; error?: string };

type StoredNotice = QueuedChannelNotice & {
  createdAt: string;
  nextAttemptAt: string;
  attempts: number;
  lastError?: string;
};

type OutboxState = { version: 1; entries: StoredNotice[] };

/** Durable, at-least-once delivery for supplementary Ticket channel notices. */
export function createChannelOutbox(options: {
  dir?: string;
  now?: () => Date;
  retryBaseMs?: number;
  pollIntervalMs?: number;
  send(entry: QueuedChannelNotice): Promise<ChannelDeliveryAttempt>;
  onError?: (error: unknown) => void;
}) {
  const now = options.now ?? (() => new Date());
  const baseMs = positive(options.retryBaseMs, DEFAULT_CHANNEL_OUTBOX_RETRY_MS);
  const pollMs = positive(
    options.pollIntervalMs,
    DEFAULT_CHANNEL_OUTBOX_RETRY_MS
  );
  const file = options.dir ? join(options.dir, "outbox.json") : undefined;
  let state: OutboxState | undefined;
  let loading: Promise<void> | undefined;
  let chain = Promise.resolve();
  let flushing: Promise<Map<string, ChannelDeliveryAttempt>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = true;

  async function load(): Promise<void> {
    if (state) return;
    if (!file) {
      state = { version: 1, entries: [] };
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      state = parseState(parsed);
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

  async function enqueue(
    entries: readonly QueuedChannelNotice[]
  ): Promise<void> {
    await serial(async () => {
      const known = new Set(state!.entries.map((entry) => entry.id));
      let changed = false;
      for (const entry of entries) {
        if (!validQueuedNotice(entry)) {
          throw new Error("Invalid Ticket channel notice for outbox");
        }
        if (known.has(entry.id)) continue;
        const at = now().toISOString();
        state!.entries.push({
          ...cloneQueuedNotice(entry),
          createdAt: at,
          nextAttemptAt: at,
          attempts: 0,
        });
        known.add(entry.id);
        changed = true;
      }
      if (changed) await persist();
    });
  }

  async function flush(): Promise<Map<string, ChannelDeliveryAttempt>> {
    if (!active) return new Map();
    if (flushing) return flushing;
    flushing = (async () => {
      const due = await serial(async () =>
        state!.entries
          .filter((entry) => Date.parse(entry.nextAttemptAt) <= now().getTime())
          .map(cloneStoredNotice)
      );
      const outcomes = new Map<string, ChannelDeliveryAttempt>();
      for (const entry of due) {
        let attempt: ChannelDeliveryAttempt;
        try {
          attempt = await options.send(cloneQueuedNotice(entry));
        } catch (error) {
          attempt = {
            status: "retry",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        outcomes.set(entry.id, attempt);
        await serial(async () => {
          const index = state!.entries.findIndex((row) => row.id === entry.id);
          if (index < 0) return;
          if (attempt.status === "sent" || attempt.status === "discard") {
            state!.entries.splice(index, 1);
          } else {
            const current = state!.entries[index]!;
            current.attempts += 1;
            current.nextAttemptAt = new Date(
              now().getTime() + retryDelay(baseMs, current.attempts)
            ).toISOString();
            current.lastError =
              attempt.error?.slice(0, 500) ?? "Channel delivery will retry";
          }
          await persist();
        });
      }
      return outcomes;
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
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

  async function pending(): Promise<QueuedChannelNotice[]> {
    return serial(async () => state!.entries.map(cloneQueuedNotice));
  }

  return { enqueue, flush, start, stop, pending };
}

function parseState(value: unknown): OutboxState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ticket channel outbox is malformed");
  }
  const input = value as Partial<OutboxState>;
  if (input.version !== 1 || !Array.isArray(input.entries)) {
    throw new Error("Ticket channel outbox has an unsupported version");
  }
  const entries: StoredNotice[] = [];
  for (const row of input.entries) {
    if (
      !row ||
      typeof row !== "object" ||
      !validQueuedNotice(row as QueuedChannelNotice) ||
      typeof (row as StoredNotice).createdAt !== "string" ||
      typeof (row as StoredNotice).nextAttemptAt !== "string" ||
      !Number.isSafeInteger((row as StoredNotice).attempts) ||
      (row as StoredNotice).attempts < 0
    ) {
      throw new Error("Ticket channel outbox contains an invalid entry");
    }
    const stored = row as StoredNotice;
    entries.push({
      ...cloneQueuedNotice(stored),
      createdAt: stored.createdAt,
      nextAttemptAt: stored.nextAttemptAt,
      attempts: stored.attempts,
      ...(typeof stored.lastError === "string"
        ? { lastError: stored.lastError.slice(0, 500) }
        : {}),
    });
  }
  return { version: 1, entries };
}

function validQueuedNotice(value: QueuedChannelNotice): boolean {
  return (
    !!value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    !!value.channel &&
    typeof value.channel.source === "string" &&
    value.channel.source.length > 0 &&
    typeof value.channel.thread === "string" &&
    value.channel.thread.length > 0 &&
    (!value.channel.address ||
      (typeof value.channel.address === "object" &&
        !Array.isArray(value.channel.address) &&
        Object.values(value.channel.address).every(
          (item) => typeof item === "string"
        ))) &&
    !!value.notice &&
    typeof value.notice.id === "string" &&
    typeof value.notice.ticketId === "string" &&
    typeof value.notice.goalId === "string" &&
    (value.notice.type === "goal_needs_person" ||
      value.notice.type === "goal_completed") &&
    typeof value.notice.message === "string"
  );
}

function cloneQueuedNotice(entry: QueuedChannelNotice): QueuedChannelNotice {
  return {
    id: entry.id,
    channel: {
      source: entry.channel.source,
      thread: entry.channel.thread,
      ...(entry.channel.address
        ? { address: { ...entry.channel.address } }
        : {}),
    },
    notice: { ...entry.notice },
  };
}

function cloneStoredNotice(entry: StoredNotice): StoredNotice {
  return {
    ...cloneQueuedNotice(entry),
    createdAt: entry.createdAt,
    nextAttemptAt: entry.nextAttemptAt,
    attempts: entry.attempts,
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
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
