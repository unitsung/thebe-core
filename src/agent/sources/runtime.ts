import type { ContainerInfoProvider } from "../capabilities/containers.ts";
import {
  CONTAINER_HEALTH_SOURCE,
  EMPTY_CURSOR,
  readContainerHealth,
  type ContainerHealthCursor,
} from "./container-health.ts";
import { gate, parseGateSettings } from "./gate.ts";
import { createSourceStore, MAX_TRIGGER_RECORDS } from "./store.ts";
import {
  threadKey,
  type SourceHealth,
  type Trigger,
  type TriggerRecord,
} from "./types.ts";

/** Repeated read failures this long are shown in the health response (and make no ticket). */
export const READ_FAILURE_ALARM_MS = 10 * 60_000;
export const DEFAULT_SOURCE_POLL_MS = 30_000;
const MAX_ERROR_LENGTH = 200;

/** Calls `tick` every `intervalMs` until the returned function is called. Tests replace it. */
export type SourceTimer = (
  tick: () => Promise<void>,
  intervalMs: number
) => () => void;

/** Runs the evaluation of one Trigger that passed the Gate. At most one runs per Thread at a time. */
export type SourceEvaluator = (trigger: Trigger) => Promise<void>;

export type SourceRuntimeOptions = {
  dir?: string;
  provider: ContainerInfoProvider;
  /** The source's entry in the policy, read on every poll so a settings change applies at once. */
  getSettings: () => Promise<Record<string, unknown> | undefined>;
  now: () => Date;
  evaluate?: SourceEvaluator;
  timer?: SourceTimer;
  pollIntervalMs?: number;
};

export type SourceRuntime = {
  start(): void;
  stop(): void;
  /** One read, gate and record cycle. Resolves once the Triggers are recorded, not once they are evaluated. */
  poll(): Promise<void>;
  listRecords(): Promise<TriggerRecord[]>;
  health(): Record<string, SourceHealth>;
};

const intervalTimer: SourceTimer = (tick, intervalMs) => {
  const handle = setInterval(() => void tick(), intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
};

/**
 * The container-health source and its Gate. Each poll reads the containers, turns what changed since the
 * saved position into immutable Triggers, records one Gate outcome for each, saves the new position, and
 * only then hands the Triggers that passed to the evaluator, one at a time per Thread.
 *
 * Order matters for restarts: Triggers are appended before the position is saved, and a Trigger's id comes
 * from the position, so a crash in between re-reads the same ids and they are recorded once.
 */
export function createSourceRuntime(
  options: SourceRuntimeOptions
): SourceRuntime {
  const store = createSourceStore<ContainerHealthCursor>({
    dir: options.dir,
    sourceId: CONTAINER_HEALTH_SOURCE,
  });
  const timer = options.timer ?? intervalTimer;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_SOURCE_POLL_MS;
  let cancelTimer: (() => void) | undefined;
  let loaded:
    | Promise<{ cursor: ContainerHealthCursor; records: TriggerRecord[] }>
    | undefined;
  let polling: Promise<void> | undefined;
  const threads = new Map<string, Promise<void>>();
  const status = {
    enabled: false,
    lastReadAt: undefined as string | undefined,
    consecutiveFailures: 0,
    failingSince: undefined as string | undefined,
    lastError: undefined as string | undefined,
  };

  function load() {
    loaded ??= (async () => ({
      cursor: (await store.loadCursor()) ?? EMPTY_CURSOR,
      records: await store.loadRecords(),
    }))();
    return loaded;
  }

  /** At most one evaluation per Thread at a time: the next waits for the one in front of it. */
  function evaluateOnThread(trigger: Trigger): void {
    if (!options.evaluate) return;
    const evaluate = options.evaluate;
    const key = threadKey(trigger.thread);
    const next = (threads.get(key) ?? Promise.resolve())
      .then(() => evaluate(trigger))
      .catch(() => undefined)
      .finally(() => {
        if (threads.get(key) === next) threads.delete(key);
      });
    threads.set(key, next);
  }

  async function cycle(): Promise<void> {
    const settings = parseGateSettings(await options.getSettings());
    status.enabled = settings.enabled;
    // A source that is off is not read at all: no provider calls, nothing recorded.
    if (!settings.enabled) {
      status.consecutiveFailures = 0;
      status.failingSince = undefined;
      status.lastError = undefined;
      return;
    }
    const state = await load();
    const readAt = options.now();
    let read: Awaited<ReturnType<typeof readContainerHealth>>;
    try {
      read = await readContainerHealth(options.provider, state.cursor, readAt);
    } catch (error) {
      if (status.consecutiveFailures === 0) {
        status.failingSince = readAt.toISOString();
      }
      status.consecutiveFailures += 1;
      status.lastError = describeError(error);
      return;
    }
    status.consecutiveFailures = 0;
    status.failingSince = undefined;
    status.lastError = undefined;
    status.lastReadAt = readAt.toISOString();

    const passed: Trigger[] = [];
    for (const trigger of read.triggers) {
      if (state.records.some((record) => record.trigger.id === trigger.id)) {
        continue;
      }
      const record: TriggerRecord = {
        trigger,
        outcome: gate(trigger, settings, readAt, state.records),
        decidedAt: readAt.toISOString(),
      };
      await store.appendRecord(record);
      state.records.push(record);
      if (state.records.length > MAX_TRIGGER_RECORDS) state.records.shift();
      if (record.outcome.result === "passed") passed.push(trigger);
    }
    await store.saveCursor(read.cursor);
    state.cursor = read.cursor;
    for (const trigger of passed) evaluateOnThread(trigger);
  }

  async function poll(): Promise<void> {
    // A slow read must not overlap the next tick; a second caller waits for the one in flight.
    if (polling) return polling;
    polling = cycle().finally(() => {
      polling = undefined;
    });
    return polling;
  }

  return {
    start() {
      if (cancelTimer) return;
      cancelTimer = timer(() => poll().catch(() => undefined), intervalMs);
    },
    stop() {
      cancelTimer?.();
      cancelTimer = undefined;
    },
    poll,
    async listRecords() {
      return [...(await load()).records];
    },
    health() {
      const failingFor =
        status.failingSince === undefined
          ? 0
          : options.now().getTime() - Date.parse(status.failingSince);
      return {
        [CONTAINER_HEALTH_SOURCE]: {
          enabled: status.enabled,
          ...(status.lastReadAt ? { lastReadAt: status.lastReadAt } : {}),
          consecutiveFailures: status.consecutiveFailures,
          ...(status.failingSince ? { failingSince: status.failingSince } : {}),
          failing: failingFor >= READ_FAILURE_ALARM_MS,
          ...(status.lastError ? { lastError: status.lastError } : {}),
        },
      };
    },
  };
}

function describeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  const text = typeof code === "string" ? `${code}: ${message}` : message;
  return text.slice(0, MAX_ERROR_LENGTH);
}
