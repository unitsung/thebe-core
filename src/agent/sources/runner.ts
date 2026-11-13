import { DEFAULT_TRIGGER_RETENTION, type TriggerStore } from "./store.ts";
import type { Source, Trigger } from "./types.ts";

export type SourceHealth = {
  id: string;
  scope: string;
  state: "starting" | "healthy" | "failing";
  consecutiveFailures: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
};

export type SourceRunner = {
  /** One concurrent read of every Source. Safe to call by hand; the timer calls the same thing. */
  pollOnce(): Promise<Trigger[]>;
  /** Current read health, in configured order. A successful read clears the failure count. */
  health(): SourceHealth[];
  start(): void;
  /** Stops new reads, aborts active reads, and waits for any commit and Trigger dispatch to finish. */
  stop(): Promise<void>;
};

export const DEFAULT_SOURCE_INTERVAL_MS = 30_000;

const ABORTED = Symbol("source-read-aborted");

/**
 * Waits for a Source read, but stops waiting as soon as the runner aborts. The read itself may not
 * honor the signal; detaching it keeps quiesce bounded while discarding its result.
 */
async function awaitUnlessAborted<T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T | typeof ABORTED> {
  // The abandoned read may still reject later; settle it so it cannot surface as unhandled.
  void work.catch(() => undefined);
  if (signal.aborted) return ABORTED;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Reads every Source concurrently on a timer, saves its new Triggers, then saves its cursor. The cursor
 * moves only after the Triggers are stored, so a crash between the two re-reads the change (and the store
 * drops the duplicate) rather than losing it. Each Source has its own read, cursor, and health, so one
 * slow or failing provider does not delay or stop the others.
 */
export function createSourceRunner(options: {
  sources: readonly Source[];
  store: TriggerStore;
  intervalMs?: number;
  now?: () => Date;
  onError?: (source: string, error: unknown) => void;
  onTriggers?: (triggers: Trigger[]) => Promise<void> | void;
  /**
   * Retries keep the newest Triggers. The default matches the Trigger store's
   * retention, so a bounded in-memory backlog never outlives what the store can
   * recover after a restart.
   */
  maxPendingDispatch?: number;
}): SourceRunner {
  const sourceIds = options.sources.map((source) => source.id);
  if (sourceIds.some((id) => !id.trim())) {
    throw new Error("Source ids must not be empty");
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("Source ids must be unique");
  }
  for (const source of options.sources) {
    const assessedKinds = source.assessedKinds;
    if (
      assessedKinds !== undefined &&
      (!Array.isArray(assessedKinds) ||
        assessedKinds.some((kind) => typeof kind !== "string" || !kind.trim()))
    ) {
      throw new Error(`Source ${source.id} returned invalid assessed kinds`);
    }
  }
  const intervalMs = options.intervalMs ?? DEFAULT_SOURCE_INTERVAL_MS;
  const maxPendingDispatch =
    options.maxPendingDispatch ?? DEFAULT_TRIGGER_RETENTION;
  if (!Number.isSafeInteger(maxPendingDispatch) || maxPendingDispatch <= 0) {
    throw new Error("maxPendingDispatch must be a positive integer");
  }
  const now = options.now ?? (() => new Date());
  const statuses = new Map<string, SourceHealth>(
    options.sources.map((source) => [
      source.id,
      {
        id: source.id,
        scope: source.scope,
        state: "starting",
        consecutiveFailures: 0,
      },
    ])
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<Trigger[]> | undefined;
  let pendingDispatch: Trigger[] = [];
  let activeController: AbortController | undefined;
  let stopped = false;

  async function dispatchPending(): Promise<void> {
    if (!options.onTriggers || pendingDispatch.length === 0) return;
    const batch = pendingDispatch;
    try {
      await options.onTriggers(batch);
      pendingDispatch = [];
    } catch (error) {
      options.onError?.("dispatch", error);
    }
  }

  async function readSource(
    source: Source,
    signal: AbortSignal
  ): Promise<Trigger[]> {
    const status = statuses.get(source.id)!;
    const attemptedAt = now().toISOString();
    try {
      const before = await options.store.cursor(source.id);
      if (signal.aborted) return [];
      // A Source that ignores the signal must not hold quiesce forever: stop() aborts, and the read
      // is detached. Its result is discarded, so the old cursor stays and the batch is read again.
      const result = await awaitUnlessAborted(
        source.read(before, signal),
        signal
      );
      // If quiesce interrupted the read, keep the old cursor so the Source can report this batch again.
      if (result === ABORTED || signal.aborted) return [];
      const triggers = result.triggers.map((trigger) => {
        const admission = source.admit?.(trigger);
        return admission === undefined ? trigger : { ...trigger, admission };
      });
      validateSourceResult(source, { ...result, triggers });
      // Once storage starts, finish the cursor write even if quiesce arrives mid-commit: the Trigger is
      // already durable, and leaving the cursor behind would replay it without dispatching it.
      const fresh = await options.store.add(triggers);
      await options.store.setCursor(source.id, result.cursor);
      statuses.set(source.id, {
        id: source.id,
        scope: source.scope,
        state: "healthy",
        consecutiveFailures: 0,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: now().toISOString(),
      });
      return fresh;
    } catch (error) {
      if (signal.aborted) return [];
      statuses.set(source.id, {
        ...status,
        state: "failing",
        consecutiveFailures: status.consecutiveFailures + 1,
        lastAttemptAt: attemptedAt,
        lastFailureAt: now().toISOString(),
        lastError: errorText(error),
      });
      options.onError?.(source.id, error);
      return [];
    }
  }

  async function pollOnce(): Promise<Trigger[]> {
    if (stopped) return [];
    // Overlapping calls share one poll, so a slow read cannot start twice.
    if (running) return running;
    const controller = new AbortController();
    activeController = controller;
    running = (async () => {
      const batches = await Promise.all(
        options.sources.map((source) => readSource(source, controller.signal))
      );
      const added = batches.flat();
      if (options.onTriggers && added.length > 0) {
        const known = new Set(pendingDispatch.map((trigger) => trigger.id));
        pendingDispatch.push(
          ...added.filter((trigger) => !known.has(trigger.id))
        );
        if (pendingDispatch.length > maxPendingDispatch) {
          const dropped = pendingDispatch.length - maxPendingDispatch;
          pendingDispatch = pendingDispatch.slice(-maxPendingDispatch);
          options.onError?.(
            "dispatch",
            new Error(
              `Source dispatch backlog exceeded ${maxPendingDispatch} Triggers; dropped ${dropped} oldest queued Trigger(s)`
            )
          );
        }
      }
      await dispatchPending();
      return added;
    })().finally(() => {
      if (activeController === controller) activeController = undefined;
      running = undefined;
    });
    return running;
  }

  return {
    pollOnce,
    health() {
      return options.sources.map((source) => ({
        ...statuses.get(source.id)!,
      }));
    },
    start() {
      if (timer || options.sources.length === 0) return;
      stopped = false;
      timer = setInterval(
        () =>
          void pollOnce().catch((error) =>
            options.onError?.("dispatch", error)
          ),
        intervalMs
      );
      timer.unref?.();
      void pollOnce().catch((error) => options.onError?.("dispatch", error));
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      activeController?.abort();
      await running?.then(
        () => undefined,
        () => undefined
      );
    },
  };
}

function errorText(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Source read failed";
  return text.length <= 500 ? text : `${text.slice(0, 500)}...`;
}

function validateSourceResult(
  source: Source,
  result: Awaited<ReturnType<Source["read"]>>
): void {
  if (
    !result ||
    typeof result.cursor !== "string" ||
    !Array.isArray(result.triggers)
  ) {
    throw new Error(`Source ${source.id} returned an invalid read result`);
  }

  for (const trigger of result.triggers) {
    if (
      !trigger ||
      !/^[a-f0-9]{32}$/.test(trigger.id) ||
      trigger.source !== source.id ||
      typeof trigger.kind !== "string" ||
      !trigger.kind.trim() ||
      typeof trigger.at !== "string" ||
      !Array.isArray(trigger.threads) ||
      trigger.threads.length === 0 ||
      trigger.threads.some(
        (thread) => typeof thread !== "string" || !thread.trim()
      ) ||
      !trigger.payload ||
      typeof trigger.payload !== "object" ||
      Array.isArray(trigger.payload)
    ) {
      throw new Error(`Source ${source.id} returned an invalid Trigger`);
    }
    if (
      trigger.actor &&
      (trigger.actor.source !== source.id ||
        typeof trigger.actor.id !== "string" ||
        !trigger.actor.id.trim())
    ) {
      throw new Error(
        `Source ${source.id} returned a Trigger with an invalid actor`
      );
    }
    if (trigger.human !== undefined && typeof trigger.human !== "boolean") {
      throw new Error(
        `Source ${source.id} returned a Trigger with an invalid human flag`
      );
    }
    if (
      trigger.admission !== undefined &&
      trigger.admission !== "explicit" &&
      trigger.admission !== "inferred" &&
      trigger.admission !== "ignore"
    ) {
      throw new Error(
        `Source ${source.id} returned a Trigger with an invalid admission`
      );
    }
    if (
      trigger.admission === "explicit" &&
      (trigger.human !== true || !trigger.actor)
    ) {
      throw new Error(
        `Source ${source.id} marked a Trigger explicit without a human actor`
      );
    }
    if (
      trigger.addressed !== undefined &&
      trigger.addressed !== "mention" &&
      trigger.addressed !== "direct"
    ) {
      throw new Error(
        `Source ${source.id} returned a Trigger with an invalid addressed value`
      );
    }
    if (trigger.channel) {
      if (
        trigger.channel.source !== source.id ||
        typeof trigger.channel.thread !== "string" ||
        !trigger.threads.includes(trigger.channel.thread) ||
        (trigger.channel.address !== undefined &&
          (!trigger.channel.address ||
            typeof trigger.channel.address !== "object" ||
            Array.isArray(trigger.channel.address) ||
            Object.values(trigger.channel.address).some(
              (value) => typeof value !== "string"
            )))
      ) {
        throw new Error(
          `Source ${source.id} returned a Trigger with an invalid channel`
        );
      }
    }
  }
}
