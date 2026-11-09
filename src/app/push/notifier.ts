import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DeviceRegistry } from "../../delivery/http/devices.ts";
import type { PushOutboxStatus } from "../../delivery/http/push-status.ts";
import { pushEventMessage, type PushIdentity } from "./identity.ts";

export type PushNotice = {
  /** `thebe.activity` or `thebe.permission`, the categories the App registers. */
  category: string;
  /** Short and generic. Never filenames, logs or credentials. */
  title: string;
  body: string;
  /** `thebe://...` route the App opens when the notice is tapped. */
  deepLink: string;
  /** Stable per event: the idempotency key the outbox and relay deduplicate on. */
  id: string;
  /**
   * What the notices are about, usually a ticket id. Notices with the same `ticket` keep their order
   * for one device and carry a sequence number to sort by. Without one, a notice stands alone.
   */
  ticket?: string;
};

export type PushNotifier = {
  /** Queues the notice for every device that registered with the relay for its category. */
  notify(notice: PushNotice): Promise<void>;
};

export type DurablePushNotifier = PushNotifier & {
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
  device: string;
  id: string;
  outcome: "delivered" | "dropped";
  reason?: string;
  at: number;
};

type SequenceState = {
  last: number;
  touchedAt: number;
};

type OutboxState = {
  version: 1;
  /** Last sequence number handed out per queue, so numbering continues after a restart. */
  seq: Record<string, SequenceState>;
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
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
}): DurablePushNotifier {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = new URL("/v1/events", options.relayUrl).toString();
  const file = options.dir ? join(options.dir, OUTBOX_FILE) : undefined;
  const state = load();
  const inflight = new Set<Promise<void>>();
  const running = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function emptyState(): OutboxState {
    return {
      version: 1,
      seq: {},
      entries: [],
      finished: [],
      consecutiveFailures: 0,
    };
  }

  function load(): OutboxState {
    if (!file) return emptyState();
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!isRecord(stored) || stored.version !== 1) return emptyState();
      const cutoff = now().getTime() - RETENTION_MS;
      const entries = Array.isArray(stored.entries)
        ? stored.entries.filter(isOutboxEntry)
        : [];
      const pendingQueues = new Set(entries.map((entry) => entry.queue));
      const seq: Record<string, SequenceState> = {};
      entries.forEach((entry) => {
        const current = seq[entry.queue];
        seq[entry.queue] = {
          last: Math.max(current?.last ?? 0, entry.seq),
          touchedAt: Math.max(current?.touchedAt ?? 0, entry.nextAttemptAt),
        };
      });
      if (isRecord(stored.seq)) {
        for (const [queue, value] of Object.entries(stored.seq)) {
          if (
            !isSequenceState(value) ||
            (value.touchedAt < cutoff && !pendingQueues.has(queue))
          ) {
            continue;
          }
          const current = seq[queue];
          seq[queue] = current
            ? {
                last: Math.max(current.last, value.last),
                touchedAt: Math.max(current.touchedAt, value.touchedAt),
              }
            : value;
        }
      }
      const finished = Array.isArray(stored.finished)
        ? stored.finished
            .filter(isFinished)
            .filter((entry) => entry.at >= cutoff)
            .slice(-MAX_FINISHED)
        : [];
      return {
        version: 1,
        seq,
        entries,
        finished,
        consecutiveFailures:
          typeof stored.consecutiveFailures === "number" &&
          Number.isInteger(stored.consecutiveFailures) &&
          stored.consecutiveFailures >= 0
            ? stored.consecutiveFailures
            : 0,
        lastError:
          typeof stored.lastError === "string" ? stored.lastError : undefined,
        lastFailureAt:
          typeof stored.lastFailureAt === "number" &&
          Number.isFinite(stored.lastFailureAt)
            ? stored.lastFailureAt
            : undefined,
      };
    } catch {
      return emptyState();
    }
  }

  function persist(): void {
    if (!file) return;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, file);
    } catch {
      // A disk that cannot be written must not break the caller; the queue still works in memory.
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Nothing else to clean up.
      }
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
      device: entry.device,
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
    const ticket = notice.ticket?.trim() || notice.id;
    const queue = `${device}|${ticket}`;
    const known =
      state.entries.some(
        (entry) => entry.device === device && entry.id === notice.id
      ) ||
      state.finished.some(
        (entry) => entry.device === device && entry.id === notice.id
      );
    if (known) return;
    const queued = state.entries.filter((entry) => entry.queue === queue);
    if (queued.length >= MAX_QUEUE_LENGTH) {
      // Never drop the notice currently being sent.
      const removable = running.has(queue) ? queued[1] : queued[0];
      if (removable) finish(removable, "dropped", "queue full");
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
    const seenQueues = new Set<string>();
    const heads: OutboxEntry[] = [];
    let nextAt: number | undefined;
    for (const entry of state.entries) {
      if (seenQueues.has(entry.queue)) continue;
      seenQueues.add(entry.queue);
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
      ticket: entry.ticket,
      seq: entry.seq,
    };
    let response: Response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...event,
          signature: options.identity.sign(pushEventMessage(event)),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
    } catch (error) {
      return {
        kind: "unavailable",
        reason: `relay unreachable: ${(error as Error).message || "error"}`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSequenceState(value: unknown): value is SequenceState {
  return (
    isRecord(value) &&
    typeof value.last === "number" &&
    Number.isInteger(value.last) &&
    value.last >= 0 &&
    typeof value.touchedAt === "number" &&
    Number.isFinite(value.touchedAt)
  );
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  return (
    isRecord(value) &&
    typeof value.queue === "string" &&
    typeof value.device === "string" &&
    typeof value.ticket === "string" &&
    typeof value.seq === "number" &&
    Number.isInteger(value.seq) &&
    value.seq > 0 &&
    typeof value.id === "string" &&
    typeof value.category === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    typeof value.deepLink === "string" &&
    typeof value.failures === "number" &&
    Number.isInteger(value.failures) &&
    value.failures >= 0 &&
    typeof value.transientFailures === "number" &&
    Number.isInteger(value.transientFailures) &&
    value.transientFailures >= 0 &&
    typeof value.nextAttemptAt === "number" &&
    Number.isFinite(value.nextAttemptAt)
  );
}

function isFinished(value: unknown): value is Finished {
  return (
    isRecord(value) &&
    typeof value.queue === "string" &&
    typeof value.device === "string" &&
    typeof value.id === "string" &&
    (value.outcome === "delivered" || value.outcome === "dropped") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    typeof value.at === "number" &&
    Number.isFinite(value.at)
  );
}
