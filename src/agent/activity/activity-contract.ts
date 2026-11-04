import { toProductProviderBackgroundTask } from "../background-tasks/product.ts";
import { toProductGoal } from "../goals/product.ts";
import type { GoalRun } from "../types.ts";
import {
  backgroundTaskToFeedItem,
  goalToFeedItem,
  recordToFeedItem,
  summarizeNeedsYou,
  scheduleObservationToFeedItem,
  triggerToFeedItem,
  type ActivityFeedItem,
} from "./feed.ts";
import { goalTicketKey } from "../tickets/types.ts";
import type { Trigger } from "../sources/types.ts";
import { PERSON_REASONS, type ActivityStage } from "./stage.ts";
import type { ScheduleObservationView } from "../schedules/types.ts";
import { ACTIVITY_KIND_RESTART, type ActivityRecord } from "./types.ts";

/**
 * Activity items with the stage Core derives, exported as data for the App's decoders and its Home model.
 * Core owns the file and builds every case with the real feed builders, so the two cannot drift. `stage`
 * is an additive field: `legacy` holds the same items as an older Core sends them, and the App must
 * decode both. `ticketId` is likewise additive: `withTicketId` is the same builder run with a ticket that
 * wraps the goal, and `items` carry none. Later tickets extend this file rather than adding another.
 */
export const ACTIVITY_CONTRACT_PATH = "contracts/activity.json";

const T0 = "2026-11-04T09:00:00.000Z";
const T1 = "2026-11-04T09:30:00.000Z";
const NOW = new Date("2026-11-04T10:00:00.000Z");

function goal(overrides: Partial<GoalRun>): GoalRun {
  return {
    thebeSessionId: "goal-1",
    goal: "Tidy the media library",
    maxIterations: 8,
    iteration: 1,
    status: "running",
    createdAt: T0,
    updatedAt: T1,
    subagentRunIds: [],
    ...overrides,
  };
}

/** A ticket id as the store derives it, pinned here so the file does not change run to run. */
const TICKET_ID = "0123456789abcdef0123456789abcdef";

const restartApproval: ActivityRecord = {
  id: "approval-1",
  kind: ACTIVITY_KIND_RESTART,
  actionId: ACTIVITY_KIND_RESTART,
  resource: {
    kind: "container",
    id: "ctr-emby",
    name: "emby",
    provider: "arcane",
  },
  status: "pending",
  group: "needs_approval",
  summary: "Restart emby",
  createdAt: T0,
  updatedAt: T1,
  idempotencyKey: "approve:container.restart:ctr-emby:run-1",
};

function containerTrigger(
  kind: string,
  severity: Trigger["severity"],
  seq: number
): Trigger {
  return {
    id: `container-health:ctr-emby:${kind}:${seq}`,
    source: "container-health",
    kind,
    severity,
    thread: { kind: "container", id: "ctr-emby", name: "emby" },
    summary: "emby turned unhealthy",
    observedAt: T1,
  };
}

function scheduleObservation(
  overrides: Partial<ScheduleObservationView>
): ScheduleObservationView {
  return {
    id: "sched-1:2026-11-04T09:00:00.000Z",
    scheduleId: "sched-1",
    title: "Nightly health check",
    goal: "Check that every container is healthy",
    dueAt: "2026-11-04T09:00:00.000Z",
    observedAt: "2026-11-04T09:00:03.000Z",
    scope: { criteria: ["Every container is running"], maxIterations: 3 },
    scheduleMode: "observe",
    ...overrides,
  };
}

function named(name: string, item: ActivityFeedItem | undefined) {
  if (!item) throw new Error(`contract case ${name} produced no item`);
  return { name, item };
}

function cases() {
  const context = { now: NOW };
  return [
    named(
      "goal asking one question",
      goalToFeedItem(
        toProductGoal(
          goal({
            status: "paused",
            summary: "Goal paused: waiting for your answer.",
            report: {
              state: "waiting",
              summary: "Two folders match.",
              at: T1,
              role: "worker",
            },
            attention: {
              question: "Which folder should I clean?",
              askedAt: T1,
              role: "worker",
            },
          })
        ),
        context
      )
    ),
    named(
      "goal blocked",
      goalToFeedItem(
        toProductGoal(
          goal({
            thebeSessionId: "goal-2",
            status: "paused",
            report: {
              state: "blocked",
              summary: "The disk is read-only.",
              at: T1,
              role: "worker",
            },
          })
        ),
        context
      )
    ),
    named(
      "goal working",
      goalToFeedItem(toProductGoal(goal({ thebeSessionId: "goal-3" })), context)
    ),
    named(
      "goal ended",
      goalToFeedItem(
        toProductGoal(
          goal({
            thebeSessionId: "goal-4",
            status: "completed",
            finishedAt: T1,
            report: {
              state: "ready",
              summary: "All tests pass.",
              at: T1,
              role: "reviewer",
            },
          })
        ),
        context
      )
    ),
    named(
      "goal failed",
      goalToFeedItem(
        toProductGoal(
          goal({
            thebeSessionId: "goal-5",
            status: "failed",
            finishedAt: T1,
            error: "The migration cannot be applied.",
            report: {
              state: "failed",
              summary: "The migration cannot be applied.",
              at: T1,
              role: "worker",
            },
          })
        ),
        context
      )
    ),
    named("confirmation waiting", recordToFeedItem(restartApproval, context)),
    named(
      "aria2 download failed",
      backgroundTaskToFeedItem(
        toProductProviderBackgroundTask("aria2", {
          id: "0123456789abcdef",
          kind: "download",
          name: "movie.mkv",
          status: "failed",
          startedAt: T0,
          finishedAt: T1,
          updatedAt: T1,
          error: "aria2 reports a download error",
        }),
        context
      )
    ),
    named(
      "container turned unhealthy, passed the gate",
      triggerToFeedItem(
        {
          trigger: containerTrigger("unhealthy", "warning", 1),
          outcome: { result: "passed" },
          decidedAt: T1,
        },
        context
      )
    ),
    named(
      "container event filtered by quiet hours",
      triggerToFeedItem(
        {
          trigger: containerTrigger("unhealthy", "warning", 2),
          outcome: { result: "filtered", reason: "quiet_hours" },
          decidedAt: T1,
        },
        context
      )
    ),
    named(
      "container event repeated, a duplicate",
      triggerToFeedItem(
        {
          trigger: containerTrigger("unhealthy", "warning", 3),
          outcome: {
            result: "duplicate",
            reason: "duplicate",
            duplicateOf: "container-health:ctr-emby:unhealthy:1",
          },
          decidedAt: T1,
        },
        context
      )
    ),
    named(
      "aria2 download running",
      backgroundTaskToFeedItem(
        toProductProviderBackgroundTask("aria2", {
          id: "fedcba9876543210",
          kind: "download",
          name: "show.mkv",
          status: "running",
          startedAt: T0,
          updatedAt: T1,
        }),
        context
      )
    ),
    named(
      "schedule would have run, still observing",
      scheduleObservationToFeedItem(scheduleObservation({}), context)
    ),
    named(
      "schedule would have run, since switched to auto",
      scheduleObservationToFeedItem(
        scheduleObservation({
          id: "sched-2:2026-11-04T08:00:00.000Z",
          scheduleId: "sched-2",
          title: "Weekly library tidy",
          dueAt: "2026-11-04T08:00:00.000Z",
          observedAt: "2026-11-04T08:00:02.000Z",
          scope: {
            criteria: [],
            model: { providerId: "company", modelId: "gpt-5.6-sol" },
          },
          scheduleMode: "auto",
        }),
        context
      )
    ),
  ];
}

function ticketedGoal(): ActivityFeedItem {
  const run = goal({
    status: "paused",
    summary: "Goal paused: waiting for your answer.",
    report: {
      state: "waiting",
      summary: "Two folders match.",
      at: T1,
      role: "worker",
    },
    attention: {
      question: "Which folder should I clean?",
      askedAt: T1,
      role: "worker",
    },
  });
  return goalToFeedItem(toProductGoal(run), {
    now: NOW,
    ticketIds: new Map([
      [goalTicketKey(run.thebeSessionId, run.createdAt), TICKET_ID],
    ]),
  });
}

const allStages: ActivityStage[] = [
  { kind: "ended" },
  ...PERSON_REASONS.map((reason) => ({ kind: "person" as const, reason })),
  { kind: "working" },
  { kind: "working", queued: true },
  { kind: "idle" },
];

export function buildActivityContract() {
  const items = cases();
  const feed = items.map((entry) => entry.item);
  return {
    version: 1,
    stages: allStages,
    /** What Core sends now: every item carries its stage. */
    items,
    /** The same items from a Core that predates stage. The App must decode these too. */
    legacy: items.map(({ name, item }) => {
      const { stage: _stage, ...rest } = item;
      return { name, item: rest };
    }),
    /** An item that also carries the ticket that wraps it; tickets add this field. */
    withTicketId: {
      name: "goal asking one question, wrapped by a ticket",
      item: ticketedGoal(),
    },
    /** The needs-you summary over `items`; it equals the number of items whose stage is person. */
    needsYou: summarizeNeedsYou(feed),
  };
}
