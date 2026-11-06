import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isQuiet,
  msUntilQuietEnds,
  type QuietHoursStore,
} from "../../delivery/http/quiet-hours.ts";
import type { PushNotice, PushNotifier } from "./notifier.ts";

export const DEFAULT_HELD_NOTICES = 10;

export type QuietHoursNotifier = PushNotifier & {
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
  inner: PushNotifier;
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
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(held)}\n`, "utf8");
    await rename(temp, file);
  }

  async function flush(): Promise<void> {
    timer = undefined;
    await load();
    const window = await options.quiet.get();
    // Still inside the window (the person moved it later): keep holding.
    if (window && isQuiet(window, now())) {
      arm(window);
      return;
    }
    const toSend = held;
    held = [];
    await save();
    for (const notice of toSend) await options.inner.notify(notice);
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
      await load();
      const window = await options.quiet.get();
      if (!window || !isQuiet(window, now())) {
        await options.inner.notify(notice);
        return;
      }
      // The same event again replaces itself rather than being sent twice later.
      held = [...held.filter((row) => row.id !== notice.id), notice].slice(
        -maxHeld
      );
      await save();
      arm(window);
    },
    async resume() {
      stopped = false;
      await load();
      if (held.length === 0) return;
      const window = await options.quiet.get();
      if (window && isQuiet(window, now())) arm(window);
      else await flush();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
