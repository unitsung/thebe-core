import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import {
  isQuiet,
  msUntilQuietEnds,
  type QuietHoursStore,
} from "../../agent/notifications/quiet-hours.ts";
import type { DurablePushNotifier, PushNotice } from "./notifier.ts";

export const DEFAULT_HELD_NOTICES = 10;

export type QuietHoursNotifier = DurablePushNotifier & {
  /** After a start: send what was held before a restart if quiet hours are over, or wait for them to end. */
  resume(): Promise<void>;
  stop(): void;
};

/**
 * Holds pushes during the person's quiet hours and sends them when the window ends. The thing a push is
 * about (an approval waiting) is untouched: it stays in the list. Only the interruption is delayed. What is
 * held is kept on disk, so a restart in the middle of the night does not drop it, and it is bounded: past
 * `maxHeld` the oldest is dropped, the newest are what the person needs.
 */
export function createQuietHoursNotifier(options: {
  inner: DurablePushNotifier;
  quiet: QuietHoursStore;
  dir?: string;
  now?: () => Date;
  maxHeld?: number;
}): QuietHoursNotifier {
  const now = options.now ?? (() => new Date());
  const maxHeld = options.maxHeld ?? DEFAULT_HELD_NOTICES;
  const file = options.dir ? join(options.dir, "quiet-held.json") : undefined;
  let held: PushNotice[] = [];
  let loaded = !file;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let chain = Promise.resolve();
  let flushing: Promise<void> | undefined;

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = chain.then(operation, operation);
    chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function load(): Promise<void> {
    if (loaded || !file) return;
    loaded = true;
    try {
      const saved = JSON.parse(await readFile(file, "utf8")) as PushNotice[];
      if (Array.isArray(saved)) held = saved.slice(-maxHeld);
    } catch {
      // Nothing held.
    }
  }

  async function save(): Promise<void> {
    if (!file || !options.dir) return;
    await mkdir(options.dir, { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(held)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      timer = undefined;
      const state = await serial(async () => {
        await load();
        const window = await options.quiet.get();
        if (window && isQuiet(window, now())) {
          return {
            held: true as const,
            window,
            notices: [] as PushNotice[],
          };
        }
        const notices = held;
        held = [];
        await save();
        return { held: false as const, notices };
      });
      // Still inside the window (the person moved it later): keep holding.
      if (state.held) {
        arm(state.window);
        return;
      }
      for (const notice of state.notices) await options.inner.notify(notice);
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }

  function arm(
    window: NonNullable<Awaited<ReturnType<QuietHoursStore["get"]>>>
  ): void {
    if (timer || stopped) return;
    timer = setTimeout(() => void flush(), msUntilQuietEnds(window, now()));
    timer.unref?.();
  }

  return {
    async notify(notice) {
      const state = await serial(async () => {
        await load();
        const window = await options.quiet.get();
        if (!window || !isQuiet(window, now())) return { held: false as const };
        // The same event again replaces itself rather than being sent twice later.
        held = [...held.filter((row) => row.id !== notice.id), notice].slice(
          -maxHeld
        );
        await save();
        return { held: true as const, window };
      });
      if (!state.held) {
        await options.inner.notify(notice);
        return;
      }
      arm(state.window);
    },
    async resume() {
      stopped = false;
      const count = await serial(async () => {
        await load();
        return held.length;
      });
      if (count === 0) return;
      const window = await options.quiet.get();
      if (window && isQuiet(window, now())) arm(window);
      else await flush();
    },
    flush() {
      return options.inner.flush();
    },
    status() {
      return options.inner.status();
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      options.inner.close();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
