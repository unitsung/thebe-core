import type { ActivityRecord } from "../activity/types.ts";
import type { ThebeSessionStats } from "../runtime/interface.ts";
import type { AgentSessionMeta } from "../store.ts";
import { httpError, type GoalRun } from "../types.ts";

/**
 * The read-only usage and effect summary. It is computed on demand from stores Core already
 * keeps (session metadata and token stats, goal runs, activity records). Nothing here is
 * persisted, collected in the background, or sent anywhere.
 */

export type UsageRange = {
  /** First local day, `YYYY-MM-DD`. */
  from: string;
  /** Last local day (inclusive), `YYYY-MM-DD`. */
  to: string;
  /** Minutes east of UTC that define where a day starts. 0 means UTC days. */
  utcOffsetMinutes: number;
};

export type UsageTokens = {
  input: number;
  output: number;
  cacheWrite: number;
  /** Reported on its own and never part of `counted`. */
  cacheRead: number;
  /** input + output + cacheWrite. */
  counted: number;
  /** Estimated cost in USD as the model runtime reports it. */
  cost: number;
};

export type UsageDayTokens = UsageTokens & { sessions: number };

export type UsageDurations = {
  count: number;
  p50Ms?: number;
  p95Ms?: number;
  maxMs?: number;
};

export type UsageGoalOutcome =
  | "completed"
  | "max_iterations"
  | "failed"
  | "cancelled"
  | "running"
  | "paused";

export type UsageGoalItem = {
  id: string;
  title: string;
  /** True when a schedule started it or it is a Goal session; see `isBackground`. */
  background: boolean;
  status: UsageGoalOutcome;
  createdAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** Absent when the session could not be read. */
  tokens?: UsageTokens;
};

export type UsageSummary = {
  range: UsageRange;
  generatedAt: string;
  days: Array<{
    day: string;
    foreground: UsageDayTokens;
    background: UsageDayTokens;
  }>;
  totals: { foreground: UsageDayTokens; background: UsageDayTokens };
  goals: {
    outcomes: Record<UsageGoalOutcome, number>;
    completion: UsageDurations;
    items: UsageGoalItem[];
  };
  confirmations: {
    /** Approved confirmations inside the range. */
    answered: number;
    /** Confirmations waiting for a person right now, whatever the range. */
    pending: number;
    wait: UsageDurations;
  };
  /** Sessions in the range whose token stats could not be read. */
  unreadableSessions: number;
};

/** What a caller asks for: an explicit day range, or the last `days` days ending today. */
export type UsageQuery = {
  from?: string;
  to?: string;
  days?: number;
  utcOffsetMinutes?: number;
};

export const MAX_USAGE_DAYS = 366;
export const DEFAULT_USAGE_DAYS = 30;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function parseDay(value: string): number | undefined {
  if (!DAY_RE.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString().slice(0, 10) === value ? time : undefined;
}

/** The local day (`YYYY-MM-DD`) an instant falls in. */
export function localDay(
  iso: string | undefined,
  utcOffsetMinutes: number
): string | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return undefined;
  return new Date(time + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function listDays(range: UsageRange): string[] {
  const first = parseDay(range.from);
  const last = parseDay(range.to);
  if (first === undefined || last === undefined) return [];
  const days: string[] = [];
  for (let time = first; time <= last; time += MS_PER_DAY) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

/** Background means a schedule started the work, or the session exists to run a Goal. */
export function isBackground(meta: Pick<AgentSessionMeta, "labels">): boolean {
  return meta.labels?.kind === "goal" || Boolean(meta.labels?.scheduleId);
}

/** The instant a session's tokens are attributed to: when it was last active. */
export function sessionActivityAt(meta: AgentSessionMeta): string | undefined {
  return meta.lastActiveAt ?? meta.updatedAt ?? meta.createdAt;
}

const emptyTokens = (): UsageTokens => ({
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  counted: 0,
  cost: 0,
});

export function tokensOf(stats: ThebeSessionStats): UsageTokens {
  const { input, output, cacheWrite, cacheRead } = stats.tokens;
  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    counted: input + output + cacheWrite,
    cost: stats.cost,
  };
}

function addTokens(into: UsageDayTokens, add: UsageTokens): void {
  into.input += add.input;
  into.output += add.output;
  into.cacheWrite += add.cacheWrite;
  into.cacheRead += add.cacheRead;
  into.counted += add.counted;
  into.cost += add.cost;
  into.sessions += 1;
}

function emptyDay(): UsageDayTokens {
  return { ...emptyTokens(), sessions: 0 };
}

function roundCost<T extends UsageTokens>(tokens: T): T {
  return { ...tokens, cost: Math.round(tokens.cost * 1e6) / 1e6 };
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], fraction: number): number {
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1]!;
}

export function durations(values: number[]): UsageDurations {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

const TERMINAL: ReadonlySet<GoalRun["status"]> = new Set([
  "completed",
  "max_iterations",
  "failed",
  "cancelled",
]);

function outcomeOf(status: GoalRun["status"]): UsageGoalOutcome {
  if (status === "pausing") return "running";
  return status;
}

export type UsageInputs = {
  range: UsageRange;
  now: Date;
  metas: AgentSessionMeta[];
  goals: GoalRun[];
  activity: ActivityRecord[];
  /** Reads one session's token stats; undefined when the session cannot be read. */
  readStats(thebeSessionId: string): Promise<ThebeSessionStats | undefined>;
};

export async function buildUsageSummary(
  input: UsageInputs
): Promise<UsageSummary> {
  const { range } = input;
  const dayList = listDays(range);
  const inRange = new Set(dayList);
  const offset = range.utcOffsetMinutes;
  const byDay = new Map(
    dayList.map((day) => [
      day,
      { foreground: emptyDay(), background: emptyDay() },
    ])
  );
  const statsCache = new Map<string, UsageTokens | undefined>();
  const read = async (id: string): Promise<UsageTokens | undefined> => {
    if (!statsCache.has(id)) {
      const stats = await input.readStats(id);
      statsCache.set(id, stats ? tokensOf(stats) : undefined);
    }
    return statsCache.get(id);
  };

  let unreadableSessions = 0;
  const metaById = new Map(
    input.metas.map((meta) => [meta.thebeSessionId, meta])
  );
  for (const meta of input.metas) {
    const day = localDay(sessionActivityAt(meta), offset);
    const bucket = day && inRange.has(day) ? byDay.get(day) : undefined;
    if (!bucket) continue;
    const tokens = await read(meta.thebeSessionId);
    if (!tokens) {
      unreadableSessions += 1;
      continue;
    }
    addTokens(
      isBackground(meta) ? bucket.background : bucket.foreground,
      tokens
    );
  }

  const totals = { foreground: emptyDay(), background: emptyDay() };
  const days = dayList.map((day) => {
    const bucket = byDay.get(day)!;
    for (const kind of ["foreground", "background"] as const) {
      const row = bucket[kind];
      const total = totals[kind];
      total.input += row.input;
      total.output += row.output;
      total.cacheWrite += row.cacheWrite;
      total.cacheRead += row.cacheRead;
      total.counted += row.counted;
      total.cost += row.cost;
      total.sessions += row.sessions;
    }
    return {
      day,
      foreground: roundCost(bucket.foreground),
      background: roundCost(bucket.background),
    };
  });

  const outcomes: Record<UsageGoalOutcome, number> = {
    completed: 0,
    max_iterations: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    paused: 0,
  };
  const items: UsageGoalItem[] = [];
  const completionMs: number[] = [];
  for (const goal of input.goals) {
    const anchor = TERMINAL.has(goal.status)
      ? (goal.finishedAt ?? goal.updatedAt ?? goal.createdAt)
      : (goal.updatedAt ?? goal.createdAt);
    const day = localDay(anchor, offset);
    if (!day || !inRange.has(day)) continue;
    const status = outcomeOf(goal.status);
    outcomes[status] += 1;
    const meta = metaById.get(goal.thebeSessionId);
    const started = Date.parse(goal.createdAt);
    const finished = goal.finishedAt ? Date.parse(goal.finishedAt) : Number.NaN;
    const durationMs =
      TERMINAL.has(goal.status) && finished >= started
        ? finished - started
        : undefined;
    if (durationMs !== undefined) completionMs.push(durationMs);
    const tokens = await read(goal.thebeSessionId);
    items.push({
      id: goal.thebeSessionId,
      title: (meta?.title ?? goal.goal).slice(0, 120),
      background: meta ? isBackground(meta) : false,
      status,
      createdAt: goal.createdAt,
      ...(goal.finishedAt ? { finishedAt: goal.finishedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(tokens ? { tokens: roundCost(tokens) } : {}),
    });
  }
  items.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );

  const waits: number[] = [];
  let pending = 0;
  for (const record of input.activity) {
    if (record.group === "needs_approval") pending += 1;
    const approvedAt = record.approval?.approvedAt;
    if (!record.approval?.approved || !approvedAt) continue;
    const day = localDay(approvedAt, offset);
    if (!day || !inRange.has(day)) continue;
    const wait = Date.parse(approvedAt) - Date.parse(record.createdAt);
    if (Number.isNaN(wait) || wait < 0) continue;
    waits.push(wait);
  }

  return {
    range,
    generatedAt: input.now.toISOString(),
    days,
    totals: {
      foreground: roundCost(totals.foreground),
      background: roundCost(totals.background),
    },
    goals: { outcomes, completion: durations(completionMs), items },
    confirmations: { answered: waits.length, pending, wait: durations(waits) },
    unreadableSessions,
  };
}

/** Turns a query into a validated range. Throws a 400 for anything malformed or too wide. */
export function resolveUsageRange(query: UsageQuery, now: Date): UsageRange {
  const utcOffsetMinutes = query.utcOffsetMinutes ?? 0;
  if (
    !Number.isInteger(utcOffsetMinutes) ||
    Math.abs(utcOffsetMinutes) > 14 * 60
  ) {
    throw httpError(
      400,
      "utcOffsetMinutes must be an integer between -840 and 840"
    );
  }
  let from = query.from;
  let to = query.to;
  if (from === undefined && to === undefined) {
    const days = query.days ?? DEFAULT_USAGE_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_USAGE_DAYS) {
      throw httpError(
        400,
        `days must be an integer between 1 and ${MAX_USAGE_DAYS}`
      );
    }
    to = localDay(now.toISOString(), utcOffsetMinutes)!;
    from = new Date(parseDay(to)! - (days - 1) * MS_PER_DAY)
      .toISOString()
      .slice(0, 10);
  } else if (from === undefined || to === undefined) {
    throw httpError(400, "from and to must be given together");
  }
  const first = parseDay(from);
  const last = parseDay(to);
  if (first === undefined || last === undefined) {
    throw httpError(400, "from and to must be dates like 2026-11-03");
  }
  if (first > last) throw httpError(400, "from must not be after to");
  if ((last - first) / MS_PER_DAY + 1 > MAX_USAGE_DAYS) {
    throw httpError(400, `the range may cover at most ${MAX_USAGE_DAYS} days`);
  }
  return { from, to, utcOffsetMinutes };
}
