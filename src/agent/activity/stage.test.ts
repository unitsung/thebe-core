import { describe, expect, it } from "vitest";
import { REPORT_STATES } from "../reports/report.ts";
import {
  activityStage,
  failureStillAsks,
  FAILURE_ATTENTION_WINDOW_MS,
  type ActivityStage,
  type ExecutorState,
  type StageFacts,
} from "./stage.ts";

const base: StageFacts = { ended: false, executor: "idle" };

describe("activityStage", () => {
  // The agreed table, first match wins. Expected values are literals, not recomputed.
  const table: Array<[string, StageFacts, ActivityStage]> = [
    [
      "ended beats everything",
      {
        ended: true,
        undelivered: true,
        questionOpen: true,
        confirmationPending: true,
        report: "failed",
        executor: "running",
      },
      { kind: "ended" },
    ],
    [
      "delivery beats a question",
      { ...base, undelivered: true, questionOpen: true },
      { kind: "person", reason: "delivery" },
    ],
    [
      "a question beats a confirmation",
      { ...base, questionOpen: true, confirmationPending: true },
      { kind: "person", reason: "answer" },
    ],
    [
      "a confirmation beats a ready report",
      { ...base, confirmationPending: true, report: "ready" },
      { kind: "person", reason: "approval" },
    ],
    [
      "ready waits for review",
      { ...base, report: "ready", executor: "running" },
      { kind: "person", reason: "review" },
    ],
    [
      "blocked",
      { ...base, report: "blocked" },
      { kind: "person", reason: "blocked" },
    ],
    [
      "failed",
      { ...base, report: "failed", executor: "queued" },
      { kind: "person", reason: "failed" },
    ],
    [
      "queued is working",
      { ...base, executor: "queued" },
      { kind: "working", queued: true },
    ],
    [
      "queued beats a waiting report",
      { ...base, executor: "queued", report: "waiting" },
      { kind: "working", queued: true },
    ],
    [
      "running is working",
      { ...base, executor: "running" },
      { kind: "working" },
    ],
    [
      "running with progress is working",
      { ...base, executor: "running", report: "progress" },
      { kind: "working" },
    ],
    [
      "a waiting report is idle even while running",
      { ...base, executor: "running", report: "waiting" },
      { kind: "idle" },
    ],
    ["nothing running is idle", base, { kind: "idle" }],
    [
      "a dropped report with nothing running is idle",
      { ...base, report: "dropped" },
      { kind: "idle" },
    ],
  ];
  it.each(table)("%s", (_name, facts, expected) => {
    expect(activityStage(facts)).toEqual(expected);
  });

  it("gives exactly one valid stage to every combination of facts", () => {
    const booleans = [false, true];
    const reports = [undefined, ...REPORT_STATES];
    const executors: ExecutorState[] = ["queued", "running", "idle"];
    const seen = new Set<string>();
    let combinations = 0;
    for (const ended of booleans)
      for (const undelivered of booleans)
        for (const questionOpen of booleans)
          for (const confirmationPending of booleans)
            for (const report of reports)
              for (const executor of executors) {
                combinations += 1;
                const stage = activityStage({
                  ended,
                  undelivered,
                  questionOpen,
                  confirmationPending,
                  report,
                  executor,
                });
                expect(["ended", "person", "working", "idle"]).toContain(
                  stage.kind
                );
                // A person stage always says why, and nothing else does.
                expect("reason" in stage).toBe(stage.kind === "person");
                // The stage never depends on key order or extra undefined keys.
                expect(stage).toEqual(
                  activityStage({
                    executor,
                    report,
                    confirmationPending,
                    questionOpen,
                    undelivered,
                    ended,
                  })
                );
                seen.add(JSON.stringify(stage));
              }
    expect(combinations).toBe(2 * 2 * 2 * 2 * 7 * 3);
    // Every stage the table can produce is reachable.
    expect([...seen].sort()).toEqual(
      [
        { kind: "ended" },
        { kind: "person", reason: "delivery" },
        { kind: "person", reason: "answer" },
        { kind: "person", reason: "approval" },
        { kind: "person", reason: "review" },
        { kind: "person", reason: "blocked" },
        { kind: "person", reason: "failed" },
        { kind: "working", queued: true },
        { kind: "working" },
        { kind: "idle" },
      ]
        .map((stage) => JSON.stringify(stage))
        .sort()
    );
  });
});

describe("failureStillAsks", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  it("asks for the person for a day, then leaves the failure in history", () => {
    const at = (offsetMs: number) =>
      new Date(now.getTime() - offsetMs).toISOString();
    expect(failureStillAsks(at(60_000), { now })).toBe(true);
    expect(failureStillAsks(at(FAILURE_ATTENTION_WINDOW_MS), { now })).toBe(
      true
    );
    expect(
      failureStillAsks(at(FAILURE_ATTENTION_WINDOW_MS + 1000), { now })
    ).toBe(false);
  });
  it("keeps asking when there is no clock or no time", () => {
    expect(failureStillAsks("2020-01-01T00:00:00Z", {})).toBe(true);
    expect(failureStillAsks(undefined, { now })).toBe(true);
  });
});
