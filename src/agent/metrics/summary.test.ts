import { describe, expect, it } from "vitest";
import type { ActivityRecord } from "../activity/types.ts";
import type { AuditRecord } from "../security/audit/audit-log.ts";
import type { GoalRun } from "../types.ts";
import { percentile, summarizeMetrics } from "./summary.ts";

const now = new Date("2026-11-06T12:00:00.000Z");

function goal(overrides: Partial<GoalRun>): GoalRun {
  return {
    thebeSessionId: "g",
    goal: "x",
    maxIterations: 3,
    iteration: 1,
    status: "completed",
    createdAt: "2026-11-06T10:00:00.000Z",
    subagentRunIds: [],
    finishedAt: "2026-11-06T10:10:00.000Z",
    ...overrides,
  };
}

function approval(
  createdAt: string,
  approvedAt: string | undefined,
  status: ActivityRecord["status"]
): ActivityRecord {
  return {
    id: createdAt,
    kind: "container.restart",
    actionId: "container.restart",
    resource: { kind: "container", id: "c", provider: "arcane" },
    status,
    group: "recent",
    summary: "s",
    createdAt,
    updatedAt: createdAt,
    idempotencyKey: "k",
    approval: {
      required: true,
      approved: true,
      approvedAt,
      source: "on_device",
    } as ActivityRecord["approval"],
  };
}

function mcp(
  identity: string,
  result: AuditRecord["result"],
  timestamp = "2026-11-06T11:00:00.000Z"
): AuditRecord {
  return {
    id: `${identity}${result}${timestamp}`,
    timestamp,
    method: "m",
    parameterHash: "h",
    responseBytes: 0,
    budgetConsumed: 0,
    redactionFired: false,
    source: "mcp",
    identity,
    result,
  };
}

describe("percentile", () => {
  it("takes the nearest rank, and nothing from nothing", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([10, 1, 5], 50)).toBe(5);
  });
});

describe("summarizeMetrics", () => {
  it("counts goal outcomes inside the window, telling a blocked one from a failure", () => {
    const summary = summarizeMetrics({
      goals: [
        goal({ thebeSessionId: "a" }),
        goal({ thebeSessionId: "b", status: "failed" }),
        goal({ thebeSessionId: "c", status: "failed", blocked: true }),
        goal({ thebeSessionId: "d", status: "max_iterations" }),
        goal({ thebeSessionId: "e", status: "cancelled" }),
        goal({
          thebeSessionId: "f",
          status: "running",
          finishedAt: undefined,
          observe: true,
        }),
        goal({ thebeSessionId: "old", createdAt: "2026-09-01T00:00:00.000Z" }),
      ],
      activity: [],
      audit: [],
      now,
      days: 30,
    });
    expect(summary.goals.started).toBe(6);
    expect(summary.goals.outcomes).toEqual({
      succeeded: 1,
      failed: 2,
      blocked: 1,
      cancelled: 1,
      running: 1,
      paused: 0,
    });
    expect(summary.goals.observeOnly).toBe(1);
    expect(summary.goals.completionSeconds).toEqual({
      count: 5,
      p50: 600,
      p95: 600,
    });
  });

  it("measures how long approvals waited, and counts the ones still pending", () => {
    const summary = summarizeMetrics({
      goals: [],
      activity: [
        approval(
          "2026-11-06T09:00:00.000Z",
          "2026-11-06T09:01:00.000Z",
          "succeeded"
        ),
        approval(
          "2026-11-06T10:00:00.000Z",
          "2026-11-06T10:10:00.000Z",
          "succeeded"
        ),
        approval("2026-11-06T11:00:00.000Z", undefined, "pending"),
      ],
      audit: [],
      now,
      days: 7,
    });
    expect(summary.approvals).toEqual({
      decided: 2,
      pending: 1,
      waitSeconds: { count: 2, p50: 60, p95: 600 },
    });
  });

  it("groups gateway calls by caller, ignoring rows that are not /mcp or are out of the window", () => {
    const summary = summarizeMetrics({
      goals: [],
      activity: [],
      audit: [
        mcp("Claude Code", "ok"),
        mcp("Claude Code", "denied"),
        mcp("Home agent", "error"),
        mcp("Claude Code", "ok", "2026-08-01T00:00:00.000Z"),
        { ...mcp("x", "ok"), source: "other" },
      ],
      now,
      days: 30,
    });
    expect(summary.gateway).toEqual({
      calls: 3,
      denied: 1,
      errors: 1,
      byCaller: [
        { identity: "Claude Code", calls: 2, denied: 1, errors: 0 },
        { identity: "Home agent", calls: 1, denied: 0, errors: 1 },
      ],
    });
  });

  it("is empty, not broken, when there is nothing", () => {
    const summary = summarizeMetrics({
      goals: [],
      activity: [],
      audit: [],
      now,
      days: 30,
    });
    expect(summary.goals.completionSeconds).toEqual({ count: 0 });
    expect(summary.gateway.byCaller).toEqual([]);
  });
});
