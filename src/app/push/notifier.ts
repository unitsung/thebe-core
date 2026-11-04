import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceRegistry } from "../../delivery/http/devices.ts";
import type { PushOutboxStatus } from "../../delivery/http/push-status.ts";
import { pushEventMessage, type PushIdentity } from "./identity.ts";

export type PushNotice = {
  /** `thebe.activity` or `thebe.permission`, the categories the App registers. */
  category: string;
  /** Short and generic. Never filenames, logs or credentials. */
  title: string;
  body: string;
  /** `thebe://…` route the App opens when the notice is tapped. */
  deepLink: string;
  /** Stable per event: the idempotency key the outbox and the relay deduplicate on. */
  id: string;
  /**
   * What the notices are about, usually a ticket id. Notices with the same `ticket` keep their order
   * for one device and carry a sequence number to sort by. Without one, a notice stands alone.
   */
  ticket?: string;
};

export type { PushOutboxStatus };

export type PushNotifier = {
  /** Queues the notice for every device that registered with the relay for its category. */
  notify(notice: PushNotice): Promise<void>;
  /** Attempts everything that is due now and waits for those attempts to finish. */
  flush(): Promise<void>;
  status(): PushOutboxStatus;
  /** Stops the retry timer. Queued notices stay on disk. */
  close(): void;
};

type OutboxEntry = {
  /** `<relayDeviceId>|<ticket>`: one ordered queue per ticket per device. */
  queue: string;
  device: string;
  ticket: string;
  seq: number;
  id: string;
  category: string;
  title: string;
  body: string;
  deepLink: string;
  /** Failed attempts of any kind; drives the back-off. */
  failures: number;
  /** Failures where the relay answered with a transient error; three of them drop the notice. */
  transientFailures: number;
  nextAttemptAt: number;
};

type Finished = {
  queue: string;
  id: string;
  outcome: "delivered" | "dropped";
  reason?: string;
  at: number;
};

type OutboxState = {
  version: 1;
  /** Last sequence number handed out per queue, so numbering continues after a restart. */
  seq: Record<string, { last: number; touchedAt: number }>;
  entries: OutboxEntry[];
  finished: Finished[];
  consecutiveFailures: number;
  lastError?: string;
  lastFailureAt?: number;
};

const OUTBOX_FILE = "push-outbox.json";
const FIRST_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 300;
const MAX_TRANSIENT_FAILURES = 3;
const MAX_QUEUE_LENGTH = 200;
const MAX_FINISHED = 1000;
const SEQ_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type Outcome =
  | { kind: "delivered" }
  | { kind: "permanent"; reason: string }
  | { kind: "transient"; reason: string }
  /** The relay could not be reached or a gateway in front of it answered: wait, never give up. */
  | { kind: "unavailable"; reason: string };

/**
 * Hands signed, minimal events to the Push Relay for every device that registered with it for
 * this category. Core holds no APNs credentials; the relay does.
 *
 * Notices go through a durable outbox. Each ticket's notices for one device form a queue that is
 * delivered in order, one at a time, each with a sequence number. The head is retried with
 * back-off (5 s doubling to 300 s) and later notices wait behind it. When the relay is
 * unreachable nothing is given up on, so an outage of any length loses no notice. When the relay
 * answers with a transient error the head is dropped after three of them; a permanent refusal
 * drops it at once. Every drop is recorded with its reason. A notice is retried under the same
 * `id`, which the relay uses to show it once.
 */
export function createPushNotifier(options: {
  relayUrl: string;
  identity: PushIdentity;
  devices: DeviceRegistry;
  /** Where the outbox is kept. Unset: kept in memory only. */
  dir?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}): PushNotifier {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = new URL("/v1/events", options.relayUrl).toString();
  const file = options.dir ? join(options.dir, OUTBOX_FILE) : undefined;
  const state = load();
  const inflight = new Set<Promise<void>>();
  const running = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function load(): OutboxState {
    const empty: OutboxState = {
      version: 1,
      seq: {},
      entries: [],
      finished: [],
      consecutiveFailures: 0,
    };
    if (!file) return empty;
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as OutboxState;
      if (stored.version !== 1 || !Array.isArray(stored.entries)) return empty;
      const cutoff = now().getTime() - SEQ_RETENTION_MS;
      const pending = new Set(stored.entries.map((entry) => entry.queue));
      for (const [queue, value] of Object.entries(stored.seq ?? {})) {
        if (value.touchedAt < cutoff && !pending.has(queue)) {
          delete stored.seq[queue];
        }
      }
      return { ...empty, ...stored };
    } catch {
      return empty;
    }
  }

  function persist(): void {
    if (!file) return;
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      renameSync(temporary, file);
    } catch {
      // A disk that cannot be written must not break the caller; the queue still works in memory.
    }
  }

  function finish(
    entry: OutboxEntry,
    outcome: Finished["outcome"],
    reason?: string
  ): void {
    state.entries = state.entries.filter((candidate) => candidate !== entry);
    state.finished.push({
      queue: entry.queue,
      id: entry.id,
      outcome,
      reason,
      at: now().getTime(),
    });
    if (state.finished.length > MAX_FINISHED) {
      state.finished.splice(0, state.finished.length - MAX_FINISHED);
    }
  }

  function enqueue(notice: PushNotice, device: string): void {
    const ticket = notice.ticket ?? notice.id;
    const queue = `${device}|${ticket}`;
    const known =
      state.entries.some(
        (entry) => entry.queue === queue && entry.id === notice.id
      ) ||
      state.finished.some(
        (entry) => entry.queue === queue && entry.id === notice.id
      );
    if (known) return;
    const queued = state.entries.filter((entry) => entry.queue === queue);
    if (queued.length >= MAX_QUEUE_LENGTH) {
      // Never the notice being sent right now.
      finish(
        running.has(queue) ? queued[1]! : queued[0]!,
        "dropped",
        "queue full"
      );
    }
    const sequence = state.seq[queue] ?? { last: 0, touchedAt: 0 };
    sequence.last += 1;
    sequence.touchedAt = now().getTime();
    state.seq[queue] = sequence;
    state.entries.push({
      queue,
      device,
      ticket,
      seq: sequence.last,
      id: notice.id,
      category: notice.category,
      title: notice.title,
      body: notice.body,
      deepLink: notice.deepLink,
      failures: 0,
      transientFailures: 0,
      nextAttemptAt: now().getTime(),
    });
  }

  function dueHeads(): { heads: OutboxEntry[]; nextAt?: number } {
    const seen = new Set<string>();
    const heads: OutboxEntry[] = [];
    let nextAt: number | undefined;
    for (const entry of state.entries) {
      if (seen.has(entry.queue)) continue;
      seen.add(entry.queue);
      if (running.has(entry.queue)) continue;
      if (entry.nextAttemptAt <= now().getTime()) heads.push(entry);
      else nextAt = Math.min(nextAt ?? Infinity, entry.nextAttemptAt);
    }
    return { heads, nextAt };
  }

  function kick(): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const { heads, nextAt } = dueHeads();
    for (const entry of heads) {
      running.add(entry.queue);
      const attempt: Promise<void> = deliver(entry).finally(() => {
        running.delete(entry.queue);
        inflight.delete(attempt);
        kick();
      });
      inflight.add(attempt);
    }
    if (nextAt !== undefined) {
      timer = setTimeout(kick, Math.max(0, nextAt - now().getTime()));
      timer.unref?.();
    }
  }

  async function deliver(entry: OutboxEntry): Promise<void> {
    const outcome = await attempt(entry);
    if (outcome.kind === "delivered" || outcome.kind === "permanent") {
      state.consecutiveFailures = 0;
      if (outcome.kind === "delivered") finish(entry, "delivered");
      else finish(entry, "dropped", outcome.reason);
    } else {
      state.consecutiveFailures += 1;
      state.lastError = outcome.reason;
      state.lastFailureAt = now().getTime();
      entry.failures += 1;
      if (outcome.kind === "transient") entry.transientFailures += 1;
      if (entry.transientFailures >= MAX_TRANSIENT_FAILURES) {
        finish(
          entry,
          "dropped",
          `${entry.transientFailures} transient failures, last: ${outcome.reason}`
        );
      } else {
        const seconds = Math.min(
          MAX_RETRY_SECONDS,
          FIRST_RETRY_SECONDS * 2 ** (entry.failures - 1)
        );
        entry.nextAttemptAt = now().getTime() + seconds * 1000;
      }
    }
    persist();
  }

  async function attempt(entry: OutboxEntry): Promise<Outcome> {
    // Signed afresh each time: the relay refuses events older than five minutes, while `id` stays.
    const event = {
      relayDeviceId: entry.device,
      id: entry.id,
      ts: Math.floor(now().getTime() / 1000),
      category: entry.category,
      title: entry.title,
      body: entry.body,
      deepLink: entry.deepLink,
    };
    let response: Response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...event,
          ticket: entry.ticket,
          seq: entry.seq,
          signature: options.identity.sign(pushEventMessage(event)),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
    } catch (error) {
      return {
        kind: "unavailable",
        reason: `relay unreachable: ${(error as Error).message ?? "error"}`,
      };
    }
    if (response.ok) return { kind: "delivered" };
    let relayError: string | undefined;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") relayError = body.error;
    } catch {
      // Not the relay's JSON: probably a proxy in front of it.
    }
    const status = response.status;
    const detail = relayError ? `: ${relayError}` : "";
    if (status === 408 || status === 429) {
      return { kind: "unavailable", reason: `relay busy (${status})${detail}` };
    }
    if (status >= 400 && status < 500) {
      return {
        kind: "permanent",
        reason: `relay refused (${status})${detail}`,
      };
    }
    if (relayError) {
      return {
        kind: "transient",
        reason: `relay answered ${status}${detail}`,
      };
    }
    return { kind: "unavailable", reason: `relay unavailable (${status})` };
  }

  kick();

  return {
    async notify(notice) {
      let devices;
      try {
        devices = await options.devices.list();
      } catch {
        return;
      }
      for (const device of devices) {
        if (
          device.relayDeviceId &&
          device.categories.includes(notice.category)
        ) {
          enqueue(notice, device.relayDeviceId);
        }
      }
      persist();
      kick();
    },
    async flush() {
      kick();
      while (inflight.size > 0) await Promise.allSettled(inflight);
    },
    status() {
      const dropped = state.finished.filter(
        (entry) => entry.outcome === "dropped"
      );
      const last = dropped.at(-1);
      return {
        pending: state.entries.length,
        consecutiveFailures: state.consecutiveFailures,
        dropped: dropped.length,
        ...(state.lastError ? { lastError: state.lastError } : {}),
        ...(state.lastFailureAt
          ? { lastFailureAt: new Date(state.lastFailureAt).toISOString() }
          : {}),
        ...(last
          ? {
              lastDrop: {
                id: last.id,
                reason: last.reason ?? "dropped",
                at: new Date(last.at).toISOString(),
              },
            }
          : {}),
      };
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
