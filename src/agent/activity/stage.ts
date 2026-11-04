/**
 * Stage: where a piece of work stands with respect to the person. It is a pure function of facts that
 * other writers already own (goal runs, receipts, background tasks, pending confirmations), is computed on
 * every read and is never stored, so the screen cannot disagree with the data.
 *
 * Borrowed from the dsh-superagent prototype's `ticketStage`: the first matching row wins.
 */
import type { ReportState } from "../reports/report.ts";
import type { TicketIndex } from "../tickets/types.ts";

export const PERSON_REASONS = [
  "delivery",
  "answer",
  "approval",
  "review",
  "blocked",
  "failed",
] as const;

/**
 * Why the person is needed: `delivery` a notice never arrived, `answer` a question is open, `approval`
 * a confirmation is waiting, `review` a result is ready to be looked at, `blocked` the work reported it
 * cannot go on, `failed` the work failed.
 */
export type PersonReason = (typeof PERSON_REASONS)[number];

export type ActivityStage =
  | { kind: "ended" }
  | { kind: "person"; reason: PersonReason }
  | { kind: "working"; queued?: true }
  | { kind: "idle" };

export type StageKind = ActivityStage["kind"];

/** Who is doing the work right now. */
export type ExecutorState = "queued" | "running" | "idle";

export type StageFacts = {
  /** Finished in a way that needs nobody: succeeded, cancelled, dropped, or a failure nobody can act on any more. */
  ended: boolean;
  /** A notice about this work could not be delivered. */
  undelivered?: boolean;
  /** One question is open and waiting for the person. */
  questionOpen?: boolean;
  /** A confirmation is waiting for the person. */
  confirmationPending?: boolean;
  /** The latest report, if any. */
  report?: ReportState;
  executor: ExecutorState;
};

/** Classifies facts into exactly one stage. The rows are in priority order; the first match wins. */
export function activityStage(facts: StageFacts): ActivityStage {
  if (facts.ended) return { kind: "ended" };
  if (facts.undelivered) return { kind: "person", reason: "delivery" };
  if (facts.questionOpen) return { kind: "person", reason: "answer" };
  if (facts.confirmationPending) return { kind: "person", reason: "approval" };
  if (facts.report === "ready") return { kind: "person", reason: "review" };
  if (facts.report === "blocked") return { kind: "person", reason: "blocked" };
  if (facts.report === "failed") return { kind: "person", reason: "failed" };
  if (facts.executor === "queued") return { kind: "working", queued: true };
  if (facts.report === "waiting" || facts.executor === "idle")
    return { kind: "idle" };
  return { kind: "working" };
}

export function isPersonStage(stage: ActivityStage): boolean {
  return stage.kind === "person";
}

/** Failures older than this stop asking for the person; they stay in history. */
export const FAILURE_ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type StageContext = {
  /** Used only to age out old failures; when absent no failure ages out. */
  now?: Date;
  /** Goal (session) ids that have a tool confirmation waiting. */
  confirmationSessionIds?: ReadonlySet<string>;
  /** Which ticket wraps which object, so items can carry `ticketId`. Absent means no ticket is known. */
  ticketIds?: TicketIndex;
};

/** True when a failure at `at` still asks for the person. */
export function failureStillAsks(
  at: string | undefined,
  context: StageContext
): boolean {
  if (!context.now || !at) return true;
  const time = Date.parse(at);
  if (Number.isNaN(time)) return true;
  return context.now.getTime() - time <= FAILURE_ATTENTION_WINDOW_MS;
}
