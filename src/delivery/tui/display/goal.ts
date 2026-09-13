import type { GoalRun } from "../../../agent/index.ts";

/** Render a completed Goal as one ordinary parent-session result block. */
export function formatGoalConclusion(run: GoalRun): string {
  const review = run.lastReview;
  const lines = [
    `### Goal ${run.status}`,
    "",
    `**Objective:** ${run.goal}`,
    `**Result:** ${run.summary ?? `Goal ${run.status}.`}`,
  ];
  if (review) {
    lines.push(`**Verification:** ${review.critique}`);
    if (review.remainingTasks?.length) {
      lines.push(`**Remaining:** ${review.remainingTasks.join("; ")}`);
    }
  }
  if (run.finalReport) {
    lines.push("", "#### Verification report", "", run.finalReport);
  }
  if (run.error) {
    lines.push("", `**Error:** ${run.error}`);
  }
  return lines.join("\n");
}
