import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A daily window in which Core does not push. `start` after `end` runs past midnight (23:00 to 07:00). */
export type QuietHours = {
  /** `HH:mm`, 24-hour. */
  start: string;
  end: string;
  /** An IANA zone such as `Asia/Shanghai`. Unset: the zone Core runs in. */
  timeZone?: string;
};

export class QuietHoursError extends Error {}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `null` or `undefined` means no quiet hours. Anything else must be a valid window. */
export function parseQuietHours(value: unknown): QuietHours | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new QuietHoursError(
      "quietHours must be an object with start and end, or null"
    );
  }
  const row = value as { start?: unknown; end?: unknown; timeZone?: unknown };
  if (typeof row.start !== "string" || !HHMM.test(row.start)) {
    throw new QuietHoursError("start must be HH:mm, 24-hour");
  }
  if (typeof row.end !== "string" || !HHMM.test(row.end)) {
    throw new QuietHoursError("end must be HH:mm, 24-hour");
  }
  if (row.start === row.end) {
    throw new QuietHoursError(
      "start and end must differ; turn quiet hours off with null instead"
    );
  }
  let timeZone: string | undefined;
  if (row.timeZone !== undefined && row.timeZone !== null) {
    if (typeof row.timeZone !== "string" || !row.timeZone) {
      throw new QuietHoursError("timeZone must be an IANA zone name");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: row.timeZone });
    } catch {
      throw new QuietHoursError(`unknown time zone: ${row.timeZone}`);
    }
    timeZone = row.timeZone;
  }
  return { start: row.start, end: row.end, ...(timeZone ? { timeZone } : {}) };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

function minuteOfDay(at: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

export function isQuiet(window: QuietHours, at: Date): boolean {
  const now = minuteOfDay(at, window.timeZone);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Milliseconds from `at` until the window ends. At least one second, so a timer never fires early. */
export function msUntilQuietEnds(window: QuietHours, at: Date): number {
  const now = minuteOfDay(at, window.timeZone);
  const minutes = (toMinutes(window.end) - now + 1440) % 1440;
  const ms =
    minutes * 60_000 - at.getUTCSeconds() * 1000 - at.getUTCMilliseconds();
  return Math.max(1000, ms);
}

export type QuietHoursStore = {
  get(): Promise<QuietHours | undefined>;
  set(value: unknown): Promise<QuietHours | undefined>;
};

export function createQuietHoursStore(options: {
  dir?: string;
}): QuietHoursStore {
  let current: QuietHours | undefined;
  let loaded = !options.dir;
  const file = options.dir ? join(options.dir, "quiet-hours.json") : undefined;

  async function load(): Promise<void> {
    if (loaded || !file) return;
    loaded = true;
    try {
      const saved = JSON.parse(await readFile(file, "utf8")) as {
        quietHours?: unknown;
      };
      current = parseQuietHours(saved.quietHours);
    } catch {
      // No file yet, or it is unreadable: no quiet hours.
    }
  }

  return {
    async get() {
      await load();
      return current;
    },
    async set(value) {
      const next = parseQuietHours(value);
      await load();
      current = next;
      if (file && options.dir) {
        await mkdir(options.dir, { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(
          temp,
          `${JSON.stringify({ quietHours: next ?? null })}\n`,
          "utf8"
        );
        await rename(temp, file);
      }
      return next;
    },
  };
}
