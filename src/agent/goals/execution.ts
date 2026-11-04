import { describeProviderFailure } from "../provider-failure.ts";
import {
  buildGoalVerifierPrompt,
  reviewGoalEvidence,
  reviewGoalReport,
  runGoalLoop,
  type GoalCheckpoint,
  type GoalEvent,
  type GoalReviewResult,
} from "./runner.ts";
import {
  reportFromText,
  type ReportInbox,
  type ReportInput,
  type ReportRole,
} from "../reports/report.ts";
import type {
  GoalRun,
  GoalRunStatus,
  SubagentRun,
  SubagentUpdate,
} from "../types.ts";

export type GoalSubagentApi = {
  spawnSubagent(input: {
    profileName: string;
    taskPrompt: string;
    parentSessionId: string;
  }): Promise<SubagentRun>;
  waitSubagent(runId: string): Promise<SubagentRun>;
  subscribeSubagent(
    runId: string,
    listener: (update: SubagentUpdate) => void
  ): () => void;
  cancelSubagent(runId: string, parentSessionId?: string): Promise<SubagentRun>;
};

export type BufferedGoalEvent = {
  event: GoalEvent;
  at: string;
};

export type ManagedGoal = GoalRun & {
  stopRequested: boolean;
  pauseRequested: boolean;
  finished: Promise<GoalRun>;
  resolveFinished: (result: GoalRun) => void;
  listeners: Set<(event: GoalEvent) => void>;
  events: BufferedGoalEvent[];
  lastReviewResult?: GoalReviewResult;
};

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

/** An executor reported it needs the owner (an answer, or it is blocked); the goal waits, paused. */
export class GoalHandoff extends Error {
  constructor(
    public readonly role: ReportRole,
    public readonly report: ReportInput
  ) {
    super(`goal handed to the owner: ${report.state}`);
  }
}

/** An executor reported that the work cannot be done. */
export class GoalReportedFailure extends Error {
  constructor(
    public readonly role: ReportRole,
    public readonly report: ReportInput
  ) {
    super(report.summary);
  }
}

/** An executor reported there was nothing to do. */
export class GoalNothingToDo extends Error {
  constructor(public readonly report: ReportInput) {
    super(report.summary);
  }
}

type GoalTerminalStatus = Exclude<
  GoalRunStatus,
  "running" | "pausing" | "paused" | "failed"
>;

type GoalExecutionDeps = {
  subagents: GoalSubagentApi;
  /** Where goal workers and reviewers submit structured reports. */
  reportInbox?: ReportInbox;
  /** Stores the latest report on the run, and its question as the run's one Attention. */
  recordReport: (
    run: ManagedGoal,
    role: ReportRole,
    input: ReportInput
  ) => void;
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
};

export async function executeGoal(
  run: ManagedGoal,
  deps: GoalExecutionDeps,
  initialIteration = 0,
  initialReview?: GoalReviewResult
): Promise<void> {
  try {
    const result = await runGoalLoop({
      options: {
        goal: run.goal,
        criteria: run.criteria,
        maxIterations: run.maxIterations,
        ...(run.answer
          ? { answer: { question: run.answer.question, text: run.answer.text } }
          : {}),
      },
      initialIteration,
      initialReview,
      execute: async (prompt, iteration) => {
        if (run.stopRequested) throw new GoalControlError("cancel");
        if (run.pauseRequested) throw new GoalControlError("pause");

        const worker = await deps.subagents.spawnSubagent({
          profileName: "goal-worker",
          taskPrompt: prompt,
          parentSessionId: run.thebeSessionId,
        });
        run.subagentRunIds.push(worker.runId);
        // The owner's answer is in this checkpoint's prompt; it is not carried into the next one.
        run.answer = undefined;
        deps.emitChild(run, iteration, "worker", { run: worker });
        const workerUnsubscribe = deps.subagents.subscribeSubagent(
          worker.runId,
          (update) => deps.emitChild(run, iteration, "worker", update)
        );
        let workerResult: SubagentRun;
        try {
          workerResult = await deps.subagents.waitSubagent(worker.runId);
        } finally {
          workerUnsubscribe();
        }
        deps.emitChild(run, iteration, "worker", { run: workerResult });
        if (run.stopRequested) throw new GoalControlError("cancel");
        if (run.pauseRequested) throw new GoalControlError("pause");
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
        const workerReport = collectReport(
          deps,
          run,
          "worker",
          worker.runId,
          workerResult.result ?? ""
        );
        if (workerReport) handOff(workerReport, "worker");

        const reviewer = await deps.subagents.spawnSubagent({
          profileName: "goal-reviewer",
          taskPrompt: buildGoalVerifierPrompt(
            {
              goal: run.goal,
              criteria: run.criteria,
              maxIterations: run.maxIterations,
            },
            [
              workerReport
                ? `Worker's structured report (${workerReport.state}): ${workerReport.summary}`
                : "",
              workerResult.result ?? "",
            ]
              .filter(Boolean)
              .join("\n\n")
          ),
          parentSessionId: run.thebeSessionId,
        });
        run.subagentRunIds.push(reviewer.runId);
        deps.emitChild(run, iteration, "reviewer", { run: reviewer });
        const reviewerUnsubscribe = deps.subagents.subscribeSubagent(
          reviewer.runId,
          (update) => deps.emitChild(run, iteration, "reviewer", update)
        );
        try {
          const reviewerResult = await deps.subagents.waitSubagent(
            reviewer.runId
          );
          run.finalReport = childReport(reviewerResult);
          deps.emitChild(run, iteration, "reviewer", { run: reviewerResult });
          if (reviewerResult.status === "failed") {
            throw new GoalChildFailure(
              "reviewer",
              failureDetail(reviewerResult.error, "reviewer")
            );
          }
          if (run.stopRequested) throw new GoalControlError("cancel");
          if (run.pauseRequested) throw new GoalControlError("pause");
          const output = reviewerResult.result ?? "";
          const reviewerReport = collectReport(
            deps,
            run,
            "reviewer",
            reviewer.runId,
            output
          );
          if (reviewerReport) handOff(reviewerReport, "reviewer");
          const checkpoint: GoalCheckpoint = {
            output,
            ...(reviewerReport ? { report: reviewerReport } : {}),
          };
          return checkpoint;
        } finally {
          reviewerUnsubscribe();
        }
      },
      reviewEvaluator: async (goal, criteria, output, report) =>
        report
          ? reviewGoalReport(goal, criteria, output, report)
          : reviewGoalEvidence(goal, criteria, output),
      onEvent: (event) => deps.onEvent(run, event),
      shouldStop: () => run.stopRequested,
    });
    const status: GoalTerminalStatus = result.status;
    await deps.setTerminal(run, status, result.summary);
  } catch (error: unknown) {
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
        `Goal paused after ${run.iteration} checkpoint(s).`
      );
      return;
    }
    if (error instanceof GoalNothingToDo) {
      await deps.setTerminal(
        run,
        "completed",
        `Nothing to do: ${error.report.summary}`
      );
      return;
    }
    if (error instanceof GoalHandoff) {
      await deps.setTerminal(
        run,
        "paused",
        error.report.question
          ? "Goal paused: waiting for your answer."
          : `Goal paused: the ${error.role} reported it is blocked.`
      );
      return;
    }
    if (error instanceof GoalReportedFailure) {
      await deps.setTerminal(
        run,
        "failed",
        `Goal stopped: the ${error.role} reported a failure at checkpoint ${run.iteration}.`,
        error.report.summary
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
  }
}

/**
 * The report a worker or reviewer made: the tool call if there was one, otherwise the older text footer
 * read once here. Stored on the run either way.
 */
function collectReport(
  deps: GoalExecutionDeps,
  run: ManagedGoal,
  role: ReportRole,
  runId: string,
  text: string
): ReportInput | undefined {
  const report = deps.reportInbox?.take(runId) ?? reportFromText(role, text);
  if (report) deps.recordReport(run, role, report);
  return report;
}

/** Waiting, blocked, failed and nothing-to-do end the checkpoint at once; progress and ready go on to review. */
function handOff(report: ReportInput, role: ReportRole): void {
  if (report.state === "waiting" || report.state === "blocked") {
    throw new GoalHandoff(role, report);
  }
  if (report.state === "failed" && role === "worker") {
    throw new GoalReportedFailure(role, report);
  }
  if (report.state === "dropped") throw new GoalNothingToDo(report);
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
