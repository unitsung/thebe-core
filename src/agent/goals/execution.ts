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
    listener: (update: SubagentUpdate) => void,
  ): () => void;
  cancelSubagent(runId: string, parentSessionId?: string): Promise<SubagentRun>;
};

export type ManagedGoal = GoalRun & {
  stopRequested: boolean;
  pauseRequested: boolean;
  finished: Promise<GoalRun>;
  resolveFinished: (result: GoalRun) => void;
  listeners: Set<(event: GoalEvent) => void>;
  lastReviewResult?: GoalReviewResult;
};

export class GoalControlError extends Error {
  constructor(public readonly action: "pause" | "cancel") {
    super(`goal ${action} requested`);
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
    update: SubagentUpdate,
  ) => void;
  onEvent: (run: ManagedGoal, event: GoalEvent) => void;
  setTerminal: (
    run: ManagedGoal,
    status: Exclude<GoalRunStatus, "running" | "pausing">,
    summary?: string,
    error?: string,
  ) => Promise<GoalRun>;
};

export async function executeGoal(
  run: ManagedGoal,
  deps: GoalExecutionDeps,
  initialIteration = 0,
  initialReview?: GoalReviewResult,
): Promise<void> {
  try {
    const result = await runGoalLoop({
      options: {
        goal: run.goal,
        criteria: run.criteria,
        maxIterations: run.maxIterations,
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
        deps.emitChild(run, iteration, "worker", { run: worker });
        const workerUnsubscribe = deps.subagents.subscribeSubagent(
          worker.runId,
          (update) => deps.emitChild(run, iteration, "worker", update),
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
        if (workerResult.status !== "completed") {
          run.finalReport = childReport(workerResult);
          return `VERDICT: blocked\nEVIDENCE: worker ${workerResult.status}: ${workerResult.error ?? "no result"}\nREMAINING: resume the goal after resolving the worker failure`;
        }
        run.finalReport = childReport(workerResult);

        const reviewer = await deps.subagents.spawnSubagent({
          profileName: "goal-reviewer",
          taskPrompt: buildGoalVerifierPrompt(
            {
              goal: run.goal,
              criteria: run.criteria,
              maxIterations: run.maxIterations,
            },
            workerResult.result ?? "",
          ),
          parentSessionId: run.thebeSessionId,
        });
        run.subagentRunIds.push(reviewer.runId);
        deps.emitChild(run, iteration, "reviewer", { run: reviewer });
        const reviewerUnsubscribe = deps.subagents.subscribeSubagent(
          reviewer.runId,
          (update) => deps.emitChild(run, iteration, "reviewer", update),
        );
        try {
          const reviewerResult = await deps.subagents.waitSubagent(reviewer.runId);
          run.finalReport = childReport(reviewerResult);
          deps.emitChild(run, iteration, "reviewer", { run: reviewerResult });
          if (run.stopRequested) throw new GoalControlError("cancel");
          if (run.pauseRequested) throw new GoalControlError("pause");
          return reviewerResult.result ?? "";
        } finally {
          reviewerUnsubscribe();
        }
      },
      reviewEvaluator: async (goal, criteria, output) =>
        reviewGoalEvidence(goal, criteria, output),
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
        `Goal cancelled after ${run.iteration} checkpoint(s).`,
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
        `Goal paused after ${run.iteration} checkpoint(s).`,
      );
      return;
    }
    await deps.setTerminal(
      run,
      "failed",
      "Goal failed before reaching an independently verified stopping condition.",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function childReport(run: SubagentRun): string | undefined {
  const report = (run.result ?? run.responseText ?? "").trim();
  if (!report) return undefined;
  return report.length > 12_000 ? `${report.slice(0, 12_000)}\n…` : report;
}
