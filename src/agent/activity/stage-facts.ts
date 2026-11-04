/**
 * Facts for each kind of Activity item. The existing writers (goal runs, the activity store, capability
 * runs, workers, background tasks) keep their own state; this only reads it into the facts `activityStage`
 * needs. Nothing here is stored.
 */
import type { CapabilityRun } from "../capabilities/invoke.ts";
import type { ProductBackgroundTask } from "../background-tasks/product.ts";
import type { ProductGoal } from "../goals/product.ts";
import { GOAL_REPORT_PROFILES } from "../goals/report-tool.ts";
import type { TriggerEntry } from "../eval/types.ts";
import type { ProductWorker } from "../subagents/product.ts";
import {
  activityStage,
  failureStillAsks,
  type ActivityStage,
  type StageContext,
  type StageFacts,
} from "./stage.ts";
import { isPendingApproval, type ActivityRecord } from "./types.ts";

const ENDED: StageFacts = { ended: true, executor: "idle" };

/** A finished failure asks for the person until it ages out of the attention window. */
function failure(at: string | undefined, context: StageContext): StageFacts {
  return failureStillAsks(at, context)
    ? { ended: false, report: "failed", executor: "idle" }
    : ENDED;
}

export function goalStageFacts(
  goal: ProductGoal,
  context: StageContext
): StageFacts {
  switch (goal.status) {
    case "queued":
      return { ended: false, executor: "queued" };
    case "running":
      return {
        ended: false,
        confirmationPending:
          context.confirmationSessionIds?.has(goal.sessionId) ?? false,
        executor: "running",
      };
    case "paused":
      // Paused for the owner (a question or a block) is different from paused by the owner.
      return {
        ended: false,
        questionOpen: goal.attention !== undefined,
        confirmationPending:
          context.confirmationSessionIds?.has(goal.sessionId) ?? false,
        report: goal.report?.state === "blocked" ? "blocked" : undefined,
        executor: "idle",
      };
    case "failed":
      return failure(goal.finishedAt ?? goal.updatedAt, context);
    case "succeeded":
    case "cancelled":
      return ENDED;
  }
}

export function recordStageFacts(
  record: ActivityRecord,
  context: StageContext
): StageFacts {
  if (isPendingApproval(record)) {
    return { ended: false, confirmationPending: true, executor: "idle" };
  }
  if (record.group === "running") return { ended: false, executor: "running" };
  switch (record.status) {
    case "failed":
    case "provider_unavailable":
    case "verification_failed":
      return failure(record.updatedAt, context);
    case "pending":
    case "succeeded":
    case "rejected":
    case "completed":
    case "insufficient_data":
      return ENDED;
  }
}

export function runStageFacts(
  run: CapabilityRun,
  context: StageContext
): StageFacts {
  switch (run.status) {
    case "queued":
      return { ended: false, executor: "queued" };
    case "running":
      return { ended: false, executor: "running" };
    case "failed":
    case "interrupted":
      return failure(run.finishedAt ?? run.updatedAt ?? run.createdAt, context);
    case "succeeded":
      return ENDED;
  }
}

export function workerStageFacts(
  worker: ProductWorker,
  context: StageContext
): StageFacts {
  switch (worker.status) {
    case "queued":
      return { ended: false, executor: "queued" };
    case "running":
      return { ended: false, executor: "running" };
    case "failed":
      // A goal's own worker and reviewer report to the goal, which carries the attention.
      return GOAL_REPORT_PROFILES.has(worker.profileName)
        ? ENDED
        : failure(worker.finishedAt ?? worker.createdAt, context);
    case "completed":
    case "cancelled":
    case "interrupted":
      return ENDED;
  }
}

export function backgroundTaskStageFacts(
  task: ProductBackgroundTask,
  context: StageContext
): StageFacts {
  switch (task.status) {
    case "running":
      return { ended: false, executor: "running" };
    case "failed":
      return failure(task.finishedAt ?? task.updatedAt, context);
    case "stopped":
      return ENDED;
  }
}

/**
 * A Gate outcome needs nobody: it is a record that an event was seen and what became of it. A Trigger that
 * passed is being worked on until Eval records its Decision, and ends with it. Every Decision, including
 * could-not-decide, ends the item: nothing is created for the person yet, and a later ticket gives an
 * accepted Decision the stage of the work it starts.
 */
export function triggerStageFacts(
  entry: TriggerEntry,
  _context: StageContext
): StageFacts {
  if (entry.outcome.result === "passed" && !entry.decision) {
    return { ended: false, executor: "running" };
  }
  return ENDED;
}

export const goalStage = (
  goal: ProductGoal,
  context: StageContext
): ActivityStage => activityStage(goalStageFacts(goal, context));
export const recordStage = (
  record: ActivityRecord,
  context: StageContext
): ActivityStage => activityStage(recordStageFacts(record, context));
export const runStage = (
  run: CapabilityRun,
  context: StageContext
): ActivityStage => activityStage(runStageFacts(run, context));
export const triggerStage = (
  record: TriggerEntry,
  context: StageContext
): ActivityStage => activityStage(triggerStageFacts(record, context));
export const workerStage = (
  worker: ProductWorker,
  context: StageContext
): ActivityStage => activityStage(workerStageFacts(worker, context));
export const backgroundTaskStage = (
  task: ProductBackgroundTask,
  context: StageContext
): ActivityStage => activityStage(backgroundTaskStageFacts(task, context));
