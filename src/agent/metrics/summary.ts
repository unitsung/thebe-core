import type { ActivityRecord } from "../activity/types.ts";
import type { AuditRecord } from "../security/audit/audit-log.ts";
import type { GoalRun } from "../types.ts";

/**
 * A read-only summary of how the assistant has been working, computed on request from what Core
 * already keeps (Goal runs, Activity records, the audit log). Nothing is collected or sent anywhere;
 * it is for the person who owns this Core. See docs/research/baseline-metrics-2026-11-03.md.
 */
export type Spread = { count: number; p50?: number; p95?: number };

export type MetricsSummary = {
  windowDays: number;
  generatedAt: string;
  goals: {
    started: number;
    outcomes: {
      succeeded: number;
      failed: number;
      blocked: number;
      cancelled: number;
      running: number;
      paused: number;
    };
    observeOnly: number;
    /** Seconds from start to finish, for the ones that finished. */
    completionSeconds: Spread;
  };
  approvals: {
    decided: number;
    pending: number;
    /** Seconds from a write being proposed to the person's decision. */
    waitSeconds: Spread;
  };
  gateway: {
    calls: number;
    denied: number;
    errors: number;
    byCaller: Array<{
      identity: string;
      calls: number;
      denied: number;
      errors: number;
    }>;
  };
};

/** The value below which `p` of the values fall (nearest rank); `undefined` for no values. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil((p / 100) * sorted.length))
  );
  return sorted[rank - 1];
}

function spread(values: number[]): Spread {
  return {
    count: values.length,
    ...(values.length
      ? { p50: percentile(values, 50), p95: percentile(values, 95) }
      : {}),
  };
}

const seconds = (from: string, to: string): number | undefined => {
  const delta = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(delta) && delta >= 0 ? Math.round(delta) : undefined;
};

export function summarizeMetrics(input: {
  goals: GoalRun[];
  activity: ActivityRecord[];
  audit: AuditRecord[];
  now: Date;
  days: number;
}): MetricsSummary {
  const since = input.now.getTime() - input.days * 86_400_000;
  const within = (at: string | undefined) => {
    const time = at ? Date.parse(at) : Number.NaN;
    return Number.isFinite(time) && time >= since;
  };

  const goals = input.goals.filter((goal) => within(goal.createdAt));
  const outcomes = {
    succeeded: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    running: 0,
    paused: 0,
  };
  const durations: number[] = [];
  for (const goal of goals) {
    switch (goal.status) {
      case "completed":
        outcomes.succeeded += 1;
        break;
      case "cancelled":
        outcomes.cancelled += 1;
        break;
      case "paused":
        outcomes.paused += 1;
        break;
      case "running":
      case "pausing":
        outcomes.running += 1;
        break;
      default:
        // failed, or ran out of checkpoints; a blocked one is told apart because the person can fix it.
        if (goal.blocked) outcomes.blocked += 1;
        else outcomes.failed += 1;
    }
    if (goal.finishedAt && goal.status !== "paused") {
      const taken = seconds(goal.createdAt, goal.finishedAt);
      if (taken !== undefined) durations.push(taken);
    }
  }

  const approvals = input.activity.filter(
    (record) => record.approval && within(record.createdAt)
  );
  const waits: number[] = [];
  let pending = 0;
  for (const record of approvals) {
    const decidedAt = record.approval?.approvedAt;
    if (record.status === "pending" || !decidedAt) {
      pending += record.status === "pending" ? 1 : 0;
      continue;
    }
    const waited = seconds(record.createdAt, decidedAt);
    if (waited !== undefined) waits.push(waited);
  }

  const callers = new Map<
    string,
    { identity: string; calls: number; denied: number; errors: number }
  >();
  let calls = 0;
  let denied = 0;
  let errors = 0;
  for (const row of input.audit) {
    if (row.source !== "mcp" || !within(row.timestamp)) continue;
    const identity = row.identity ?? "anonymous";
    const entry = callers.get(identity) ?? {
      identity,
      calls: 0,
      denied: 0,
      errors: 0,
    };
    entry.calls += 1;
    calls += 1;
    if (row.result === "denied") {
      entry.denied += 1;
      denied += 1;
    } else if (row.result === "error") {
      entry.errors += 1;
      errors += 1;
    }
    callers.set(identity, entry);
  }

  return {
    windowDays: input.days,
    generatedAt: input.now.toISOString(),
    goals: {
      started: goals.length,
      outcomes,
      observeOnly: goals.filter((goal) => goal.observe).length,
      completionSeconds: spread(durations),
    },
    approvals: { decided: waits.length, pending, waitSeconds: spread(waits) },
    gateway: {
      calls,
      denied,
      errors,
      byCaller: [...callers.values()].sort((a, b) => b.calls - a.calls),
    },
  };
}
