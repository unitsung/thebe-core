/**
 * Five-field cron for Goal schedules: `minute hour day-of-month month day-of-week`, evaluated in an
 * IANA time zone (so "0 9 * * *" is nine o'clock where the owner is, across daylight saving).
 *
 * Supported per field: `*`, a number, `a-b`, a list `a,b,c`, and a step `*​/n` or `a-b/n`. Day of week
 * is 0-6 with 7 also meaning Sunday. As in Vixie cron, when both day-of-month and day-of-week are
 * restricted a day matches if either does. Names (JAN, MON) and `@daily`-style macros are not supported.
 */

export type CronSpec = {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
};

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function parseField(
  text: string,
  field: (typeof FIELDS)[number]
): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`invalid ${field.name} field "${text}"`);
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1)
      throw new Error(`invalid step in ${field.name} field "${text}"`);
    let from: number;
    let to: number;
    if (match[1] === "*") {
      from = field.min;
      to = field.name === "day of week" ? 6 : field.max;
    } else {
      const [a, b] = match[1]!.split("-");
      from = Number(a);
      to =
        b === undefined
          ? match[2] === undefined
            ? from
            : field.max
          : Number(b);
    }
    if (from < field.min || to > field.max || from > to)
      throw new Error(`${field.name} out of range in "${text}"`);
    for (let value = from; value <= to; value += step)
      values.add(field.name === "day of week" && value === 7 ? 0 : value);
  }
  return { values, restricted: text !== "*" && !/^\*\/1$/.test(text) };
}

export function parseCron(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      "a cron expression has five fields: minute hour day-of-month month day-of-week"
    );
  const [minute, hour, day, month, weekday] = parts.map((part, index) =>
    parseField(part, FIELDS[index]!)
  );
  return {
    minutes: minute!.values,
    hours: hour!.values,
    days: day!.values,
    months: month!.values,
    weekdays: weekday!.values,
    daysRestricted: day!.restricted,
    weekdaysRestricted: weekday!.restricted,
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of an instant in a time zone. */
function wallClock(ms: number, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, formatter);
  }
  const fields: Record<string, string> = {};
  for (const part of formatter.formatToParts(ms))
    fields[part.type] = part.value;
  return {
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour) % 24,
    minute: Number(fields.minute),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      fields.weekday!
    ),
  };
}

function dayMatches(
  spec: CronSpec,
  clock: { day: number; weekday: number }
): boolean {
  const day = spec.days.has(clock.day);
  const weekday = spec.weekdays.has(clock.weekday);
  if (spec.daysRestricted && spec.weekdaysRestricted) return day || weekday;
  return day && weekday;
}

const MINUTE = 60_000;

/** The first minute at or after `fromMs` that matches, or undefined within about five years. */
export function nextCronRun(
  spec: CronSpec,
  timeZone: string,
  fromMs: number
): number | undefined {
  let t = Math.ceil(fromMs / MINUTE) * MINUTE;
  const limit = t + 5 * 366 * 24 * 60 * MINUTE;
  while (t < limit) {
    const clock = wallClock(t, timeZone);
    if (!spec.months.has(clock.month) || !dayMatches(spec, clock)) {
      // Not a day that matches: go to the next local midnight (re-checked, so DST days settle themselves).
      t += ((24 - clock.hour) * 60 - clock.minute) * MINUTE;
    } else if (!spec.hours.has(clock.hour)) {
      t += (60 - clock.minute) * MINUTE;
    } else if (!spec.minutes.has(clock.minute)) {
      t += MINUTE;
    } else {
      return t;
    }
  }
  return undefined;
}
