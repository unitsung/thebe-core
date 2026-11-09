import { describe, expect, it } from "vitest";
import type { ProductGoal } from "../goals/product.ts";
import { toActivityFeed, type ActivityFeedItem } from "./feed.ts";
import { ACTIVITY_STAGES, activityStage, withStage } from "./stage.ts";
import type { ActivityRecord } from "./types.ts";

const now = new Date("2026-11-06T12:00:00.000Z");

function goal(overrides: Partial<ProductGoal>): ActivityFeedItem {
  return toActivityFeed(
    [],
    [
      {
        id: "g",
        sessionId: "g",
        title: "Task",
        status: "running",
        phase: "running",
        iteration: 1,
        maxIterations: 3,
        createdAt: "2026-11-06T09:00:00.000Z",
        updatedAt: "2026-11-06T09:30:00.000Z",
        controls: { pause: true, resume: false, stop: true },
        ...overrides,
      },
    ]
  )[0]!;
}

function receipt(
  status: ActivityRecord["status"],
  updatedAt: string
): ActivityFeedItem {
  return toActivityFeed(
    [
      {
        id: `r-${status}`,
        kind: "container_restart",
        actionId: "container_restart",
        resource: { kind: "container", id: "c", provider: "arcane" },
        status,
        group: "recent",
        summary: "Restart",
        createdAt: updatedAt,
        updatedAt,
        idempotencyKey: "k",
        action: {
          status: status === "succeeded" ? "succeeded" : "failed",
          summary: "x",
        },
      } as ActivityRecord,
    ],
    []
  )[0]!;
}

describe("activityStage", () => {
  it("puts a waiting approval with the person", () => {
    const [item] = toActivityFeed(
      [
        {
          id: "a",
          kind: "container_restart",
          actionId: "container_restart",
          resource: { kind: "container", id: "c", provider: "arcane" },
          status: "pending",
          group: "needs_approval",
          summary: "Restart",
          createdAt: "2026-11-06T11:00:00Z",
          updatedAt: "2026-11-06T11:00:00Z",
          idempotencyKey: "k",
        },
      ],
      []
    );
    expect(activityStage(item!, now)).toEqual({
      stage: "person",
      reason: "approval",
    });
  });

  it("maps a goal by status, and ages a failure into history after a day", () => {
    expect(activityStage(goal({ status: "queued" }), now).stage).toBe(
      "working"
    );
    expect(activityStage(goal({ status: "running" }), now).stage).toBe(
      "working"
    );
    expect(activityStage(goal({ status: "paused" }), now).stage).toBe("idle");
    expect(activityStage(goal({ status: "succeeded" }), now).stage).toBe(
      "ended"
    );
    expect(activityStage(goal({ status: "cancelled" }), now).stage).toBe(
      "ended"
    );
    expect(
      activityStage(
        goal({ status: "failed", finishedAt: "2026-11-06T08:00:00.000Z" }),
        now
      )
    ).toEqual({ stage: "person", reason: "failed" });
    expect(
      activityStage(
        goal({ status: "failed", finishedAt: "2026-11-05T11:59:00.000Z" }),
        now
      )
    ).toEqual({ stage: "ended" });
  });

  it("says a task that stopped on a blocker is blocked, with the same window", () => {
    const blocked = (finishedAt: string) =>
      goal({
        status: "failed",
        finishedAt,
        error: { code: "goal_blocked", message: "grant access" },
      });
    expect(activityStage(blocked("2026-11-06T09:00:00.000Z"), now)).toEqual({
      stage: "person",
      reason: "blocked",
    });
    expect(activityStage(blocked("2026-11-04T09:00:00.000Z"), now)).toEqual({
      stage: "ended",
    });
  });

  it("keeps a task waiting on the person in front of them however old it is, and a plain pause idle", () => {
    const waiting = (kind: "answer" | "review") =>
      goal({
        status: "paused",
        updatedAt: "2026-10-01T09:00:00.000Z",
        attention: {
          id: "a1",
          kind,
          question: "Which?",
          askedAt: "2026-10-01T09:00:00.000Z",
        },
      });
    expect(activityStage(waiting("answer"), now)).toEqual({
      stage: "person",
      reason: "answer",
    });
    expect(activityStage(waiting("review"), now)).toEqual({
      stage: "person",
      reason: "review",
    });
    expect(activityStage(goal({ status: "paused" }), now)).toEqual({
      stage: "idle",
    });
    expect(
      activityStage(
        goal({
          status: "paused",
          watchdog: {
            state: "waiting_for_person",
            reason: "worker_inactivity",
            action: "pause",
            since: "2026-11-06T10:00:00.000Z",
            at: "2026-11-06T10:20:00.000Z",
          },
        }),
        now
      )
    ).toEqual({ stage: "person", reason: "stalled" });
  });

  it("does not put a failed background task or a service's failed transfer in front of the person", () => {
    const failedTask = toActivityFeed([], [], undefined, [], [], [
      {
        id: "t1",
        sessionId: "provider-openlist",
        provider: "openlist",
        status: "failed",
        updatedAt: "2026-11-06T11:00:00.000Z",
      },
      {
        id: "t2",
        sessionId: "provider-openlist",
        provider: "openlist",
        status: "running",
        updatedAt: "2026-11-06T11:00:00.000Z",
      },
    ] as never);
    expect(
      failedTask.map((item) => activityStage(item, now).stage).sort()
    ).toEqual(["ended", "working"]);
  });

  it("treats a failure with no readable time as history, not news", () => {
    expect(
      activityStage(
        goal({ status: "failed", finishedAt: "yesterday", updatedAt: "?" }),
        now
      )
    ).toEqual({
      stage: "ended",
    });
  });

  it("keeps a failed restart in front of the person for a day, a refused or good one not", () => {
    expect(
      activityStage(receipt("failed", "2026-11-06T10:00:00Z"), now)
    ).toEqual({
      stage: "person",
      reason: "failed",
    });
    expect(
      activityStage(receipt("failed", "2026-11-01T10:00:00Z"), now).stage
    ).toBe("ended");
    expect(
      activityStage(receipt("rejected", "2026-11-06T10:00:00Z"), now).stage
    ).toBe("ended");
    expect(
      activityStage(receipt("succeeded", "2026-11-06T10:00:00Z"), now).stage
    ).toBe("ended");
  });

  it("gives every item exactly one stage, and withStage only adds fields", () => {
    const items = [
      goal({ status: "running" }),
      goal({ status: "failed", finishedAt: "2026-11-06T11:00:00Z" }),
      goal({ status: "paused" }),
      goal({ status: "succeeded" }),
    ];
    for (const item of items) {
      const stage = activityStage(item, now).stage;
      expect(
        ACTIVITY_STAGES.filter((candidate) => candidate === stage)
      ).toHaveLength(1);
      expect(withStage(item, now)).toMatchObject({ ...item, stage });
    }
  });
});
