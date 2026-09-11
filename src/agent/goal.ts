import type { RuntimeSession, RuntimeModelRef } from "../runtime/types.ts";

export type GoalEvent =
  | {
      type: "goal_started";
      goal: string;
      criteria?: string[];
      maxIterations: number;
    }
  | {
      type: "goal_iteration";
      iteration: number;
      maxIterations: number;
    }
  | {
      type: "goal_reviewed";
      iteration: number;
      complete: boolean;
      score: number;
      critique: string;
      remainingTasks?: string[];
    }
  | {
      type: "goal_completed";
      complete: boolean;
      totalIterations: number;
      summary: string;
    };

export interface GoalOptions {
  goal: string;
  criteria?: string[];
  maxIterations?: number;
  reviewModel?: RuntimeModelRef;
}

export interface GoalReviewResult {
  complete: boolean;
  critique: string;
  score: number;
  remainingTasks?: string[];
}

export interface GoalRunResult {
  complete: boolean;
  iterations: number;
  summary: string;
  reviews: GoalReviewResult[];
}

export type GoalReviewEvaluator = (
  goal: string,
  criteria: string[] | undefined,
  latestOutput: string,
) => Promise<GoalReviewResult>;

/**
 * Default heuristic review evaluator for goal tasks.
 * Evaluates completion based on output signals, errors, and criteria matching.
 */
export async function defaultHeuristicReview(
  goal: string,
  criteria: string[] | undefined,
  latestOutput: string,
): Promise<GoalReviewResult> {
  const text = latestOutput.toLowerCase();

  // Check for common error or incomplete signals
  const hasError = text.includes("error:") || text.includes("failed:") || text.includes("exception");
  const hasIncomplete =
    text.includes("still working") ||
    text.includes("in progress") ||
    text.includes("pending verification") ||
    text.includes("partially complete");

  // Check criteria satisfaction if specified
  let satisfiedCriteria = 0;
  const remainingTasks: string[] = [];

  if (criteria && criteria.length > 0) {
    for (const c of criteria) {
      const cWords = c.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const matched = cWords.some((w) => text.includes(w));
      if (matched && !hasError) {
        satisfiedCriteria++;
      } else {
        remainingTasks.push(c);
      }
    }
    const score = Math.round((satisfiedCriteria / criteria.length) * 100);
    const complete = satisfiedCriteria === criteria.length && !hasError;
    return {
      complete,
      score,
      critique: complete
        ? "All stated criteria have been verified and satisfied."
        : `Satisfied ${satisfiedCriteria} of ${criteria.length} criteria. Unresolved tasks remain.`,
      remainingTasks,
    };
  }

  // Without explicit criteria, evaluate completion cues
  const explicitDone =
    text.includes("completed successfully") ||
    text.includes("task complete") ||
    text.includes("objective achieved") ||
    text.includes("all checks passed") ||
    text.includes("finished");

  const complete = explicitDone && !hasError && !hasIncomplete;
  const score = complete ? 100 : hasError ? 30 : 60;

  return {
    complete,
    score,
    critique: complete
      ? "Goal reached with positive completion signals."
      : hasError
        ? "Encountered failures or errors during execution that need remediation."
        : "Task in progress or lacks explicit success confirmation.",
    remainingTasks: complete ? [] : ["Verify output and address any outstanding items."],
  };
}

export interface RunGoalLoopOptions {
  session: RuntimeSession;
  options: GoalOptions;
  reviewEvaluator?: GoalReviewEvaluator;
  onEvent?: (event: GoalEvent) => void;
}

/**
 * Runs an autonomous Goal Mode execution and review loop until completion or max iterations.
 */
export async function runGoalLoop(params: RunGoalLoopOptions): Promise<GoalRunResult> {
  const { session, options, reviewEvaluator, onEvent } = params;
  const maxIterations = options.maxIterations ?? 5;
  const evaluator = reviewEvaluator ?? defaultHeuristicReview;

  const emit = (event: GoalEvent) => {
    if (onEvent) {
      onEvent(event);
    }
  };

  emit({
    type: "goal_started",
    goal: options.goal,
    criteria: options.criteria,
    maxIterations,
  });

  const reviews: GoalReviewResult[] = [];
  let currentPrompt = [
    `### High-Level Goal:`,
    options.goal,
    options.criteria && options.criteria.length > 0
      ? `\n### Success Criteria:\n${options.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
      : "",
    `\nPlease execute the necessary steps to achieve this goal. Report your progress and confirm completion.`,
  ].filter(Boolean).join("\n");

  let iteration = 0;
  let isComplete = false;

  while (iteration < maxIterations) {
    iteration++;

    emit({
      type: "goal_iteration",
      iteration,
      maxIterations,
    });

    // 1. Execute agent turn
    await session.prompt(currentPrompt);
    const latestOutput = session.lastAssistantText();

    // 2. Review phase
    const review = await evaluator(options.goal, options.criteria, latestOutput);
    reviews.push(review);

    emit({
      type: "goal_reviewed",
      iteration,
      complete: review.complete,
      score: review.score,
      critique: review.critique,
      remainingTasks: review.remainingTasks,
    });

    if (review.complete) {
      isComplete = true;
      break;
    }

    if (iteration < maxIterations) {
      // 3. Prepare steer prompt for next iteration based on review critique
      currentPrompt = [
        `### Goal Review (Iteration ${iteration}):`,
        `Score: ${review.score}/100`,
        `Critique: ${review.critique}`,
        review.remainingTasks && review.remainingTasks.length > 0
          ? `Remaining items to address:\n${review.remainingTasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
          : "",
        `Please address the critique and continue until the goal is fully accomplished.`,
      ].filter(Boolean).join("\n");
    }
  }

  const finalSummary = isComplete
    ? `Goal successfully accomplished in ${iteration} iteration(s).`
    : `Goal reached maximum iteration limit (${maxIterations}) with score ${reviews.at(-1)?.score ?? 0}/100.`;

  emit({
    type: "goal_completed",
    complete: isComplete,
    totalIterations: iteration,
    summary: finalSummary,
  });

  return {
    complete: isComplete,
    iterations: iteration,
    summary: finalSummary,
    reviews,
  };
}
