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

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function localDateTime(at: Date, timeZone?: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function minuteOfDay(at: Date, timeZone?: string): number {
  const local = localDateTime(at, timeZone);
  return local.hour * 60 + local.minute;
}

function offsetMs(at: Date, timeZone?: string): number {
  const local = localDateTime(at, timeZone);
  const wallClock = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second
  );
  return wallClock - (at.getTime() - at.getUTCMilliseconds());
}

function matchingLocalInstants(
  local: Omit<LocalDateTime, "second">,
  timeZone?: string
): Date[] {
  const wallClock = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute
  );
  const offsets = new Set<number>();
  for (const delta of [
    -2 * 86_400_000,
    -86_400_000,
    0,
    86_400_000,
    2 * 86_400_000,
  ]) {
    offsets.add(offsetMs(new Date(wallClock + delta), timeZone));
  }
  const matches: Date[] = [];
  for (const offset of offsets) {
    const candidate = new Date(wallClock - offset);
    const actual = localDateTime(candidate, timeZone);
    if (
      actual.year === local.year &&
      actual.month === local.month &&
      actual.day === local.day &&
      actual.hour === local.hour &&
      actual.minute === local.minute
    ) {
      matches.push(candidate);
    }
  }
  return matches
    .filter(
      (candidate, index) =>
        matches.findIndex((row) => row.getTime() === candidate.getTime()) ===
        index
    )
    .sort((left, right) => left.getTime() - right.getTime());
}

function offsetTransitions(start: Date, end: Date, timeZone?: string): Date[] {
  const transitions: Date[] = [];
  const step = 60 * 60_000;
  let cursor = start.getTime();
  let previousOffset = offsetMs(start, timeZone);
  while (cursor < end.getTime()) {
    const next = Math.min(cursor + step, end.getTime());
    const nextOffset = offsetMs(new Date(next), timeZone);
    if (nextOffset !== previousOffset) {
      let low = cursor;
      let high = next;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (offsetMs(new Date(middle), timeZone) === previousOffset) {
          low = middle;
        } else {
          high = middle;
        }
      }
      transitions.push(new Date(high));
      previousOffset = nextOffset;
    }
    cursor = next;
  }
  return transitions;
}

export function isQuiet(window: QuietHours, at: Date): boolean {
  const now = minuteOfDay(at, window.timeZone);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Milliseconds from `at` until the window ends. At least one second, so a timer never fires early. */
export function msUntilQuietEnds(window: QuietHours, at: Date): number {
  if (!isQuiet(window, at)) return 1000;
  const current = localDateTime(at, window.timeZone);
  const now = current.hour * 60 + current.minute;
  const end = toMinutes(window.end);
  const localDate = new Date(
    Date.UTC(current.year, current.month - 1, current.day + (end > now ? 0 : 1))
  );
  const candidates = matchingLocalInstants(
    {
      year: localDate.getUTCFullYear(),
      month: localDate.getUTCMonth() + 1,
      day: localDate.getUTCDate(),
      hour: Math.floor(end / 60),
      minute: end % 60,
    },
    window.timeZone
  ).filter((candidate) => candidate.getTime() > at.getTime());
  const endAt = candidates.find((candidate) => !isQuiet(window, candidate));
  if (endAt) {
    const transition = offsetTransitions(at, endAt, window.timeZone).find(
      (candidate) =>
        candidate.getTime() > at.getTime() && !isQuiet(window, candidate)
    );
    if (transition) {
      return Math.max(1000, transition.getTime() - at.getTime());
    }
    return Math.max(1000, endAt.getTime() - at.getTime());
  }

  // A DST gap can skip the configured local end time. Fall back to the first
  // real minute that is outside the window.
  let cursor = new Date(Math.ceil((at.getTime() + 1) / 60_000) * 60_000);
  for (let minute = 0; minute < 2 * 1440; minute += 1) {
    if (!isQuiet(window, cursor)) {
      return Math.max(1000, cursor.getTime() - at.getTime());
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return 24 * 60 * 60_000;
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
