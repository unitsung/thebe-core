import { describeProviderFailure } from "../provider-failure.ts";
import { newAttentionId, type GoalReportInbox } from "./report.ts";
import {
  buildGoalVerifierPrompt,
  reviewGoalEvidence,
  runGoalLoop,
  type GoalEvent,
  type GoalReviewResult,
} from "./runner.ts";
import type {
  GoalRun,
  GoalRunStatus,
  MandateDenial,
  SubagentRun,
  SubagentUpdate,
} from "../types.ts";

export type GoalSubagentApi = {
  spawnSubagent(input: {
    profileName: string;
    taskPrompt: string;
    parentSessionId: string;
    background?: boolean;
  }): Promise<SubagentRun>;
  waitSubagent(runId: string): Promise<SubagentRun>;
  subscribeSubagent(
    runId: string,
    listener: (update: SubagentUpdate) => void
  ): () => void;
  cancelSubagent(runId: string, parentSessionId?: string): Promise<SubagentRun>;
  takeMandateDenial(parentSessionId: string): MandateDenial | undefined;
};

export type BufferedGoalEvent = {
  event: GoalEvent;
  at: string;
};

export type ManagedGoal = GoalRun & {
  stopRequested: boolean;
  pauseRequested: boolean;
  watchdogRetryRequested?: {
    runId: string;
    role: "worker" | "reviewer";
    at: string;
  };
  personNoticeId?: string;
  finished: Promise<GoalRun>;
  resolveFinished: (result: GoalRun) => void;
  listeners: Set<(event: GoalEvent) => void>;
  events: BufferedGoalEvent[];
  lastReviewResult?: GoalReviewResult;
};

/**
 * The worker said, through `goal_report`, that this Goal should stop here and why. It is not a failure
 * of the machinery: `blocked` needs the person to change something, `dropped` needs nothing done.
 */
export class GoalReportStop extends Error {
  constructor(
    public readonly kind: "blocked" | "dropped",
    public readonly detail: string
  ) {
    super(`goal reported ${kind}: ${detail}`);
  }
}

export class GoalControlError extends Error {
  constructor(public readonly action: "pause" | "cancel") {
    super(`goal ${action} requested`);
  }
}

/** A worker or reviewer run itself failed (provider, auth, runtime), as opposed to not finishing the work. */
export class GoalChildFailure extends Error {
  constructor(
    public readonly role: "worker" | "reviewer",
    detail: string
  ) {
    super(detail);
  }
}

type GoalTerminalStatus = Exclude<
  GoalRunStatus,
  "running" | "pausing" | "paused" | "failed"
>;

type GoalExecutionDeps = {
  subagents: GoalSubagentApi;
  emitChild: (
    run: ManagedGoal,
    iteration: number,
    role: "worker" | "reviewer",
    update: SubagentUpdate
  ) => void;
  onEvent: (run: ManagedGoal, event: GoalEvent) => void;
  setTerminal: (
    run: ManagedGoal,
    status: Exclude<GoalRunStatus, "running" | "pausing">,
    summary?: string,
    error?: string
  ) => Promise<GoalRun>;
  reportInbox: GoalReportInbox;
  now: () => Date;
};

export async function executeGoal(
  run: ManagedGoal,
  deps: GoalExecutionDeps,
  initialIteration = 0,
  initialReview?: GoalReviewResult
): Promise<void> {
  async function cancelSpawnedIfControlled(runId: string): Promise<void> {
    if (!run.stopRequested && !run.pauseRequested) return;
    await deps.subagents.cancelSubagent(runId, run.thebeSessionId);
  }

  try {
    const result = await runGoalLoop({
      options: {
        goal: run.goal,
        criteria: run.criteria,
        maxIterations: run.maxIterations,
        observe: run.observe,
        executor: run.executor,
        allowAsk: run.allowAsk,
        guidance: run.guidance,
      },
      initialIteration,
      initialReview,
      execute: async (prompt, iteration) => {
        if (run.stopRequested) throw new GoalControlError("cancel");
        if (run.pauseRequested) throw new GoalControlError("pause");

        deps.reportInbox.open(run.thebeSessionId, {
          allowAsk: Boolean(run.allowAsk),
        });
        let workerResult: SubagentRun | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const worker = await deps.subagents.spawnSubagent({
            // Observe mode is enforced by the profile's tool list, not by asking the model nicely.
            profileName: run.observe
              ? "goal-observer"
              : run.executor === "ticket"
                ? "ticket-worker"
                : "goal-worker",
            taskPrompt: prompt,
            parentSessionId: run.thebeSessionId,
            background: true,
          });
          run.subagentRunIds.push(worker.runId);
          deps.emitChild(run, iteration, "worker", { run: worker });
          const workerUnsubscribe = deps.subagents.subscribeSubagent(
            worker.runId,
            (update) => deps.emitChild(run, iteration, "worker", update)
          );
          try {
            await cancelSpawnedIfControlled(worker.runId);
            workerResult = await deps.subagents.waitSubagent(worker.runId);
          } finally {
            workerUnsubscribe();
          }
          deps.emitChild(run, iteration, "worker", { run: workerResult });
          const watchdogRetry =
            workerResult.status === "cancelled" &&
            attempt === 0 &&
            run.watchdogRetryRequested?.runId === worker.runId &&
            run.watchdogRetryRequested.role === "worker";
          if (watchdogRetry) {
            run.watchdogRetryRequested = undefined;
            continue;
          }
          break;
        }
        if (!workerResult) {
          throw new GoalChildFailure("worker", "worker did not start");
        }
        const mandateDenial = deps.subagents.takeMandateDenial(
          run.thebeSessionId
        );
        if (run.stopRequested) throw new GoalControlError("cancel");
        if (run.pauseRequested) throw new GoalControlError("pause");
        if (mandateDenial) {
          throw new GoalReportStop("blocked", mandateDenial.detail);
        }
        // A failed run is an infrastructure error; retrying burns every checkpoint on the same cause.
        if (workerResult.status === "failed") {
          throw new GoalChildFailure(
            "worker",
            failureDetail(workerResult.error, "worker")
          );
        }
        if (workerResult.status !== "completed") {
          run.finalReport = childReport(workerResult);
          return `VERDICT: blocked\nEVIDENCE: worker ${workerResult.status}: ${workerResult.error ?? "no result"}\nREMAINING: resume the goal after resolving the worker failure`;
        }
        run.finalReport = childReport(workerResult);

        // What the worker reported through the tool decides before the reviewer is paid for: a blocker,
        // a question or "nothing to do" ends the checkpoint here. Without a report, the text is judged as before.
        const report = deps.reportInbox.take(run.thebeSessionId);
        if (report) {
          run.report = report;
          if (report.state === "blocked") {
            throw new GoalReportStop("blocked", report.blocker ?? "blocked");
          }
          if (report.state === "dropped") {
            throw new GoalReportStop(
              "dropped",
              report.reason ?? "no action needed"
            );
          }
          if (report.state === "ask") {
            run.attention = {
              id: newAttentionId(),
              kind: "answer",
              question: report.question ?? "",
              ...(report.options?.length ? { options: report.options } : {}),
              askedAt: report.at,
            };
            // The existing pause path carries it to `paused`; the attention is what says it waits for the person.
            throw new GoalControlError("pause");
          }
        }
        const workerText = [
          workerResult.result ?? "",
          report && (report.state === "ready" || report.state === "progress")
            ? [
                "",
                "## Structured report from the worker",
                `state: ${report.state}`,
                report.summary ? `summary: ${report.summary}` : "",
                report.evidence ? `evidence: ${report.evidence}` : "",
              ]
                .filter((line) => line !== "")
                .join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n");

        let reviewerResult: SubagentRun | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const reviewer = await deps.subagents.spawnSubagent({
            profileName:
              run.executor === "ticket" ? "ticket-reviewer" : "goal-reviewer",
            taskPrompt: buildGoalVerifierPrompt(
              {
                goal: run.goal,
                criteria: run.criteria,
                maxIterations: run.maxIterations,
              },
              workerText
            ),
            parentSessionId: run.thebeSessionId,
            background: true,
          });
          run.subagentRunIds.push(reviewer.runId);
          deps.emitChild(run, iteration, "reviewer", { run: reviewer });
          const reviewerUnsubscribe = deps.subagents.subscribeSubagent(
            reviewer.runId,
            (update) => deps.emitChild(run, iteration, "reviewer", update)
          );
          try {
            await cancelSpawnedIfControlled(reviewer.runId);
            reviewerResult = await deps.subagents.waitSubagent(reviewer.runId);
          } finally {
            reviewerUnsubscribe();
          }
          run.finalReport = childReport(reviewerResult);
          deps.emitChild(run, iteration, "reviewer", { run: reviewerResult });
          const watchdogRetry =
            reviewerResult.status === "cancelled" &&
            attempt === 0 &&
            run.watchdogRetryRequested?.runId === reviewer.runId &&
            run.watchdogRetryRequested.role === "reviewer";
          if (watchdogRetry) {
            run.watchdogRetryRequested = undefined;
            continue;
          }
          break;
        }
        if (!reviewerResult) {
          throw new GoalChildFailure("reviewer", "reviewer did not start");
        }
        if (reviewerResult.status === "failed") {
          throw new GoalChildFailure(
            "reviewer",
            failureDetail(reviewerResult.error, "reviewer")
          );
        }
        if (run.stopRequested) throw new GoalControlError("cancel");
        if (run.pauseRequested) throw new GoalControlError("pause");
        return reviewerResult.result ?? "";
      },
      reviewEvaluator: async (goal, criteria, output) =>
        reviewGoalEvidence(goal, criteria, output),
      onEvent: (event) => deps.onEvent(run, event),
      shouldStop: () => run.stopRequested,
    });
    if (result.blocked) {
      // Not a failure of the machinery: the work needs the person. It ends as `failed` so every client
      // already shows it, and `blocked` lets Activity tell the two apart.
      run.blocked = true;
      await deps.setTerminal(run, "failed", result.summary, result.blocker);
      return;
    }
    if (result.status === "completed" && run.reviewBeforeDone) {
      // Passed the independent review, but this task asked to be shown first. It waits, paused, for the
      // person's accept or their note; accepting finishes it without another checkpoint.
      run.attention = {
        id: newAttentionId(),
        kind: "review",
        question:
          "The task finished and passed the independent review. Accept the result, or say what to change.",
        askedAt: deps.now().toISOString(),
      };
      await deps.setTerminal(run, "paused", "Goal is ready for your review.");
      return;
    }
    const status: GoalTerminalStatus = result.status;
    await deps.setTerminal(run, status, result.summary);
  } catch (error: unknown) {
    if (error instanceof GoalReportStop && !run.stopRequested) {
      if (error.kind === "blocked") {
        run.blocked = true;
        await deps.setTerminal(
          run,
          "failed",
          `Goal blocked at checkpoint ${run.iteration}: it needs a decision or change from you.`,
          error.detail
        );
      } else {
        await deps.setTerminal(
          run,
          "completed",
          `Goal ended at checkpoint ${run.iteration}: nothing needed doing (${error.detail}).`
        );
      }
      return;
    }
    if (
      run.stopRequested ||
      (error instanceof GoalControlError && error.action === "cancel")
    ) {
      await deps.setTerminal(
        run,
        "cancelled",
        `Goal cancelled after ${run.iteration} checkpoint(s).`
      );
      return;
    }
    if (
      run.pauseRequested ||
      (error instanceof GoalControlError && error.action === "pause")
    ) {
      run.pauseRequested = false;
      await deps.setTerminal(
        run,
        "paused",
        run.attention
          ? run.attention.kind === "review"
            ? "Goal is ready for your review."
            : "Goal is waiting for your answer."
          : `Goal paused after ${run.iteration} checkpoint(s).`
      );
      return;
    }
    await deps.setTerminal(
      run,
      "failed",
      error instanceof GoalChildFailure
        ? `Goal stopped: the ${error.role} run failed at checkpoint ${run.iteration}.`
        : "Goal failed before reaching an independently verified stopping condition.",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    deps.subagents.takeMandateDenial(run.thebeSessionId);
    deps.reportInbox.close(run.thebeSessionId);
  }
}

function failureDetail(error: string | undefined, role: string): string {
  if (!error) return `${role} failed without a message`;
  return describeProviderFailure(error)?.message ?? error;
}

function childReport(run: SubagentRun): string | undefined {
  const report = (run.result ?? run.responseText ?? "").trim();
  if (!report) return undefined;
  return report.length > 12_000 ? `${report.slice(0, 12_000)}\n…` : report;
}
