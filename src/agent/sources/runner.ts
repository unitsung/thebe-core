import type { TriggerStore } from "./store.ts";
import type { Source, Trigger } from "./types.ts";

export type SourceRunner = {
  /** One read of every Source. Safe to call by hand; the timer calls the same thing. */
  pollOnce(): Promise<Trigger[]>;
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
  onError?: (source: string, error: unknown) => void;
  onTriggers?: (triggers: Trigger[]) => void;
}): SourceRunner {
  const intervalMs = options.intervalMs ?? DEFAULT_SOURCE_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<Trigger[]> | undefined;

  async function pollOnce(): Promise<Trigger[]> {
    // A slow read must not overlap the next tick.
    if (running) return running;
    running = (async () => {
      const added: Trigger[] = [];
      for (const source of options.sources) {
        try {
          const before = await options.store.cursor(source.id);
          const result = await source.read(before);
          added.push(...(await options.store.add(result.triggers)));
          await options.store.setCursor(source.id, result.cursor);
        } catch (error) {
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
