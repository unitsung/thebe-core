import type { ActivityFeedItem } from "./feed.ts";

/**
 * Where an Activity item stands for the person, derived and never stored. The names are the ticket
 * stages of docs/research/concept-ledger-2026-11-03.md; the first matching rule wins, so the stages
 * never overlap and every item has exactly one:
 *
 *  - `person`: it needs the person now. `approval` is a write waiting for their yes; `failed` is
 *    something that did not finish and has not yet aged out of the window below.
 *  - `working`: queued or running.
 *  - `idle`: paused, waiting to be resumed.
 *  - `ended`: finished, cancelled, refused, or failed long enough ago to be history.
 *
 * Home counts `person` and the list it opens is the same filter, so the two cannot disagree.
 */
export const ACTIVITY_STAGES = ["person", "working", "idle", "ended"] as const;
export type ActivityStage = (typeof ACTIVITY_STAGES)[number];
export type PersonReason =
  | "approval"
  | "failed"
  | "blocked"
  | "answer"
  | "review";
export type ActivityStageInfo = { stage: ActivityStage; reason?: PersonReason };

/** A failure stays in front of the person this long; after that it is history in Activity. */
export const FAILED_ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

function recentFailure(
  at: string | undefined,
  now: Date,
  reason: PersonReason = "failed"
): ActivityStageInfo {
  const time = at ? Date.parse(at) : Number.NaN;
  // A failure with no readable time is not shown as news; it cannot be placed in the window.
  return Number.isFinite(time) &&
    now.getTime() - time <= FAILED_ATTENTION_WINDOW_MS
    ? { stage: "person", reason }
    : { stage: "ended" };
}

export function activityStage(
  item: ActivityFeedItem,
  now: Date = new Date()
): ActivityStageInfo {
  switch (item.type) {
    case "approval":
      return { stage: "person", reason: "approval" };
    case "goal":
      switch (item.goal.status) {
        case "queued":
        case "running":
          return { stage: "working" };
        case "paused":
          // Something is waiting on the person, so it does not age into history: letting it fall out of
          // sight is exactly the silent wait that is not allowed. A plain pause is idle.
          return item.goal.attention
            ? {
                stage: "person",
                reason:
                  item.goal.attention.kind === "review" ? "review" : "answer",
              }
            : { stage: "idle" };
        case "failed":
          return recentFailure(
            item.goal.finishedAt ?? item.goal.updatedAt,
            now,
            item.goal.error?.code === "goal_blocked" ? "blocked" : "failed"
          );
        default:
          return { stage: "ended" };
      }
    case "receipt":
      if (item.group === "running") return { stage: "working" };
      return ["failed", "verification_failed", "provider_unavailable"].includes(
        item.receipt.status
      )
        ? recentFailure(item.receipt.updatedAt, now)
        : { stage: "ended" };
    case "run":
      if (item.run.status === "queued" || item.run.status === "running") {
        return { stage: "working" };
      }
      return item.run.status === "failed"
        ? recentFailure(item.run.finishedAt ?? item.updatedAt, now)
        : { stage: "ended" };
    case "worker":
      // A worker belongs to the task or chat that started it, which reports its own failure.
      return item.worker.status === "queued" || item.worker.status === "running"
        ? { stage: "working" }
        : { stage: "ended" };
    case "background_task":
      // A detached command or a service's transfer is not something the person asked the assistant to do,
      // and its failure has its own page (Downloads, the file manager). Counting every failed one as
      // "needs you" floods Home on a busy NAS, so only "running" matters here.
      return item.task.status === "running"
        ? { stage: "working" }
        : { stage: "ended" };
    case "diagnosis":
      return { stage: "ended" };
  }
}

/** The feed item with its stage beside it, as `GET /v1/activity` returns it. */
export function withStage<T extends ActivityFeedItem>(
  item: T,
  now: Date = new Date()
): T & ActivityStageInfo {
  return { ...item, ...activityStage(item, now) };
}
