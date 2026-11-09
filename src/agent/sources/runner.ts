import type { TriggerStore } from "./store.ts";
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
  /** One read of every Source. Safe to call by hand; the timer calls the same thing. */
  pollOnce(): Promise<Trigger[]>;
  /** Current read health, in configured order. A successful read clears the failure count. */
  health(): SourceHealth[];
  start(): void;
  stop(): void;
};

export const DEFAULT_SOURCE_INTERVAL_MS = 30_000;

/**
 * Reads each Source on a timer, saves the new Triggers once, then saves the cursor. The cursor moves only
 * after the Triggers are stored, so a crash between the two re-reads the change (and the store drops the
 * duplicate) rather than losing it. One Source failing does not stop the others.
 */
export function createSourceRunner(options: {
  sources: readonly Source[];
  store: TriggerStore;
  intervalMs?: number;
  now?: () => Date;
  onError?: (source: string, error: unknown) => void;
  onTriggers?: (triggers: Trigger[]) => void;
}): SourceRunner {
  const intervalMs = options.intervalMs ?? DEFAULT_SOURCE_INTERVAL_MS;
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

  async function pollOnce(): Promise<Trigger[]> {
    // A slow read must not overlap the next tick.
    if (running) return running;
    running = (async () => {
      const added: Trigger[] = [];
      for (const source of options.sources) {
        const status = statuses.get(source.id)!;
        const attemptedAt = now().toISOString();
        try {
          const before = await options.store.cursor(source.id);
          const result = await source.read(before);
          added.push(...(await options.store.add(result.triggers)));
          await options.store.setCursor(source.id, result.cursor);
          statuses.set(source.id, {
            id: source.id,
            scope: source.scope,
            state: "healthy",
            consecutiveFailures: 0,
            lastAttemptAt: attemptedAt,
            lastSuccessAt: now().toISOString(),
          });
        } catch (error) {
          statuses.set(source.id, {
            ...status,
            state: "failing",
            consecutiveFailures: status.consecutiveFailures + 1,
            lastAttemptAt: attemptedAt,
            lastFailureAt: now().toISOString(),
            lastError: errorText(error),
          });
          options.onError?.(source.id, error);
        }
      }
      if (added.length > 0) options.onTriggers?.(added);
      return added;
    })().finally(() => {
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
      timer = setInterval(() => void pollOnce(), intervalMs);
      timer.unref?.();
      void pollOnce();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
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
