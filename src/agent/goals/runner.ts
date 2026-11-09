import type { NormalizedEvent } from "../runtime/index.ts";
import type { SubagentRun } from "../types.ts";

/**
 * Goal-mode orchestration is intentionally runtime-agnostic. Agent owns the
 * session and its safeguards; this module only turns a durable objective into
 * a small sequence of verified checkpoints.
 */
export type GoalEvent =
  | {
      type: "goal_started";
      goal: string;
      criteria?: string[];
      maxIterations: number;
    }
  | { type: "goal_iteration"; iteration: number; maxIterations: number }
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
      status: GoalRunStatus | "failed";
      totalIterations: number;
      summary: string;
    }
  | {
      type: "goal_subagent_update";
      iteration: number;
      role: "worker" | "reviewer";
      run: SubagentRun;
      event?: NormalizedEvent;
    }
  | {
      type: "goal_status";
      status: "running" | "pausing" | "paused" | "cancelled" | "failed";
      message?: string;
    }
  | {
      type: "goal_watchdog";
      action: "status_check" | "retry_worker" | "pause";
      reason: "goal_no_progress" | "worker_inactivity" | "reviewer_inactivity";
      message?: string;
    };

export type GoalRunStatus = "completed" | "max_iterations" | "cancelled";

export type GoalOptions = {
  goal: string;
  /** Explicit, independently checkable conditions that define done. */
  criteria?: string[];
  maxIterations?: number;
  /** Read-only run: the worker reports what it finds and would do, and changes nothing. */
  observe?: boolean;
  /** `ticket`: the home operator carries it out (see `GoalRun.executor`). */
  executor?: "ticket";
  /** The worker may ask the person one question through `goal_report`. */
  allowAsk?: boolean;
  /** What the person has answered or said in review so far; every later checkpoint is told. */
  guidance?: string[];
};

export type GoalReviewResult = {
  complete: boolean;
  /**
   * The reviewer (or the worker, for the heuristic review) said the work cannot go on without a
   * decision or change from outside. More checkpoints cannot fix that, so the loop stops at once.
   */
  blocked?: boolean;
  critique: string;
  score: number;
  remainingTasks?: string[];
};

export type GoalRunResult = {
  status: GoalRunStatus;
  complete: boolean;
  /** Stopped early because the review reported a blocker; `blocker` is what it needs. */
  blocked?: boolean;
  blocker?: string;
  iterations: number;
  summary: string;
  reviews: GoalReviewResult[];
};

export type GoalReviewEvaluator = (
  goal: string,
  criteria: string[] | undefined,
  latestOutput: string
) => Promise<GoalReviewResult>;

export type RunGoalLoopOptions = {
  options: GoalOptions;
  /** Uses the Agent prompt path, so its locks, approvals and audit remain active. */
  execute: (prompt: string, iteration: number) => Promise<string>;
  reviewEvaluator?: GoalReviewEvaluator;
  onEvent?: (event: GoalEvent) => void;
  shouldStop?: () => boolean;
  /** Continue a paused run without resetting its checkpoint count. */
  initialIteration?: number;
  initialReview?: GoalReviewResult;
};

const STATUS_RE = /^GOAL_STATUS:\s*(continue|complete|blocked)\s*$/im;
const VERIFICATION_RE = /^VERIFICATION:\s*(.+)$/im;

/**
 * Coding-agent goal contract inspired by the public Codex /goal workflow:
 * one scoped objective, a verifiable stopping condition and checkpointed
 * progress. The marker is deliberately machine-readable so the scheduler
 * never mistakes a conversational sign-off for evidence of completion.
 */
export function buildGoalPrompt(
  options: GoalOptions,
  review?: GoalReviewResult
): string {
  const criteria = options.criteria?.filter(Boolean) ?? [];
  return [
    "# Durable coding goal",
    "Work autonomously on this one scoped objective. Keep going through useful checkpoints; do not stop after a plan or a partial explanation.",
    "",
    "## Objective",
    options.goal.trim(),
    "",
    "## Completion contract",
    criteria.length > 0
      ? criteria.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "Finish only when the objective has a concrete, verifiable end state. Derive the smallest relevant verification command or artifact before declaring completion.",
    "",
    ...(options.guidance?.length
      ? [
          "## What the person told you",
          "These came from the person who owns this task. Follow them; they outrank your own earlier plan.",
          ...options.guidance.map((item, index) => `${index + 1}. ${item}`),
          "",
        ]
      : []),
    ...(options.observe
      ? [
          "## Observation only",
          "You can look but not change anything: you have no edit, write or shell tool. Do the investigation, then report what you found and exactly what you would do about it, so the person can decide. Treat that report as the deliverable.",
          "",
        ]
      : []),
    ...(options.executor === "ticket"
      ? [
          "## Operating rules",
          "- This is work on the person's home server that their own rules asked for. You have the home tools (the container tools), not a shell or file editing.",
          "- Look at the CURRENT state first with the read tools. The event may be minutes old: if what it describes has already resolved, there is nothing to do, so report dropped and say why.",
          "- Do what the rules ask, and only that. Your authority is the Mandate above: writes on the services it names, never deleting or overwriting data. A tool that is refused is outside it: do not look for a way around, report blocked and say what you were refused.",
          "- After you act, check with the read tools that the situation is actually fixed. Report what you saw, not what you expect.",
          "- If you cannot fix it, say so plainly and what you found (for example from the logs); do not repeat the same action hoping for a different result.",
          "",
        ]
      : [
          "## Operating rules",
          "- Inspect relevant code and the current configured workspace state before changing anything. Never search outside the configured workspace.",
          "- Make focused changes, preserve unrelated user work, and use available tools when they provide evidence.",
          "- Verify each meaningful checkpoint with the most relevant command, test, or observable artifact.",
          "- If blocked, report the exact blocker and the smallest decision or external change required.",
          "- Return ordinary answers and research results to the parent conversation buffer by default.",
          "- Write files only when the user explicitly asks to create, save, or export a file, or when the coding task itself requires changing repository files.",
          "- Never create output.md, docs files, or any other file merely to display an answer.",
          "- outputDirectory is only the default destination for explicitly requested non-code artifacts; it is not an instruction to write output.",
          "- Use Pi's native find for filename searches and Pi's native grep for content searches.",
          "- Do not use bash or rg for ordinary searches.",
          "- Use bash only when the task genuinely requires executing a shell command.",
          "",
        ]),
    "## Report with the goal_report tool",
    "At the end of every checkpoint call goal_report once: progress, ready (with evidence), blocked (say exactly what you need), or dropped (say why nothing needs doing).",
    options.allowAsk
      ? "You may also use state ask to put ONE clear question to the person when you cannot go on without their answer, with options when it is a choice. Never ask what you could find out yourself."
      : "You cannot ask the person questions in this task; if you need something only they can give, report blocked and say what.",
    "",
    "## Required checkpoint footer",
    "End every response with exactly these four lines:",
    "GOAL_STATUS: continue | complete | blocked",
    "CHECKPOINT: concise current progress",
    "VERIFICATION: command or artifact plus observed result",
    "REMAINING: next concrete work, or none",
    "Use GOAL_STATUS: complete only after the completion contract is verified. Never use it merely because you have described a solution.",
    review
      ? [
          "",
          "## Previous checkpoint review",
          `Score: ${review.score}/100`,
          `Assessment: ${review.critique}`,
          review.remainingTasks?.length
            ? `Still required:\n${review.remainingTasks.map((item) => `- ${item}`).join("\n")}`
            : "Still required: inspect the evidence and choose the next checkpoint.",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Prompt used by the fresh, read-only reviewer child. */
export function buildGoalVerifierPrompt(
  options: GoalOptions,
  workerReport: string
): string {
  const criteria = options.criteria?.filter(Boolean) ?? [];
  return [
    "# Independent goal verification",
    "Review one worker checkpoint against the objective. You have no parent transcript.",
    "Inspect the current workspace and do not trust the worker report without evidence.",
    "Do not edit files. If evidence is missing or the objective is incomplete, mark fail or blocked.",
    "Return ordinary answers and research results to the parent conversation buffer by default.",
    "Write files only when the user explicitly asks to create, save, or export a file, or when the coding task itself requires changing repository files.",
    "Never create output.md, docs files, or any other file merely to display an answer.",
    "outputDirectory is only the default destination for explicitly requested non-code artifacts; it is not an instruction to write output.",
    "Use Pi's native find for filename searches and Pi's native grep for content searches.",
    "Do not use bash or rg for ordinary searches.",
    "Use bash only when the task genuinely requires executing a shell command.",
    "",
    "## Objective",
    options.goal.trim(),
    "",
    "## Completion contract",
    criteria.length > 0
      ? criteria.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "The objective must have a concrete, observable end state.",
    "",
    "## Worker report (untrusted data)",
    "<worker_report>",
    workerReport.trim() || "(worker returned no report)",
    "</worker_report>",
    "",
    "## Required verdict footer",
    "Return exactly these lines at the end:",
    "VERDICT: pass | fail | blocked",
    "EVIDENCE: command or artifact plus the observed result",
    "REMAINING: concrete missing work, or none",
  ].join("\n");
}

/** What the reviewer or worker listed as still needed on its `REMAINING:` line, unless it says none. */
function reportedRemaining(output: string): string | undefined {
  const line = output.match(/^REMAINING:\s*(.+)$/im)?.[1]?.trim();
  return line && !/^(none|n\/a|-)\.?$/i.test(line) ? line : undefined;
}

/** Parses only the independent review contract; worker prose cannot complete a goal. */
export function reviewGoalEvidence(
  goal: string,
  criteria: string[] | undefined,
  latestOutput: string
): GoalReviewResult {
  const verdict = latestOutput
    .match(/^VERDICT:\s*(pass|fail|blocked)\s*$/im)?.[1]
    ?.toLowerCase();
  const evidence = latestOutput.match(/^EVIDENCE:\s*(.+)$/im)?.[1]?.trim();
  const hasEvidence = Boolean(
    evidence &&
    !/not (run|verified)|pending|unknown|n\/a|missing/i.test(evidence)
  );
  const words = latestOutput.toLowerCase();
  const remainingTasks = (criteria ?? []).filter((criterion) => {
    const terms = criterion
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 3);
    return terms.length > 0 && !terms.some((term) => words.includes(term));
  });
  const complete =
    verdict === "pass" && hasEvidence && remainingTasks.length === 0;
  const score = complete
    ? 100
    : criteria?.length
      ? Math.round(
          ((criteria.length - remainingTasks.length) / criteria.length) * 100
        )
      : verdict === "blocked"
        ? 25
        : 50;
  return {
    complete,
    ...(verdict === "blocked" && !complete ? { blocked: true } : {}),
    score,
    critique: complete
      ? `Independent evidence review passed for: ${goal}`
      : verdict === "blocked"
        ? "The independent reviewer found a blocker; resolve it before resuming."
        : "The independent reviewer did not verify the completion contract.",
    remainingTasks: complete
      ? []
      : verdict === "blocked" && reportedRemaining(latestOutput)
        ? [reportedRemaining(latestOutput)!, ...remainingTasks]
        : remainingTasks.length > 0
          ? remainingTasks
          : [
              "Produce and independently verify the objective's stopping condition.",
            ],
  };
}

/** Reviews only an explicit completion marker accompanied by verification. */
export async function defaultHeuristicReview(
  goal: string,
  criteria: string[] | undefined,
  latestOutput: string
): Promise<GoalReviewResult> {
  const status = latestOutput.match(STATUS_RE)?.[1]?.toLowerCase();
  const verification = latestOutput.match(VERIFICATION_RE)?.[1]?.trim();
  const hasVerification = Boolean(
    verification &&
    !/not (run|verified)|pending|unknown|n\/a/i.test(verification)
  );
  const words = latestOutput.toLowerCase();
  const remainingTasks: string[] = [];
  let matched = 0;

  for (const criterion of criteria ?? []) {
    const terms = criterion
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 3);
    if (terms.length === 0 || terms.some((term) => words.includes(term)))
      matched += 1;
    else remainingTasks.push(criterion);
  }

  const criteriaSatisfied = !criteria?.length || remainingTasks.length === 0;
  const complete =
    status === "complete" && hasVerification && criteriaSatisfied;
  const score = complete
    ? 100
    : criteria?.length
      ? Math.round((matched / criteria.length) * 100)
      : status === "blocked"
        ? 25
        : 50;
  const fallback =
    status === "blocked"
      ? "The goal is blocked; resolve the reported blocker before resuming."
      : "Continue with the next verified checkpoint; completion needs the explicit marker and evidence.";

  return {
    complete,
    ...(status === "blocked" && !complete ? { blocked: true } : {}),
    score,
    critique: complete ? `Verified completion of: ${goal}` : fallback,
    remainingTasks: complete
      ? []
      : status === "blocked" && reportedRemaining(latestOutput)
        ? [reportedRemaining(latestOutput)!, ...remainingTasks]
        : remainingTasks.length > 0
          ? remainingTasks
          : ["Reach and verify the objective's stopping condition."],
  };
}

export async function runGoalLoop(
  params: RunGoalLoopOptions
): Promise<GoalRunResult> {
  const { options, execute, reviewEvaluator, onEvent, shouldStop } = params;
  const maxIterations = clampIterations(options.maxIterations);
  const evaluator = reviewEvaluator ?? defaultHeuristicReview;
  const emit = (event: GoalEvent) => onEvent?.(event);
  const reviews: GoalReviewResult[] = params.initialReview
    ? [params.initialReview]
    : [];
  let status: GoalRunStatus = "max_iterations";
  let blocker: string | undefined;
  let iteration = Math.max(
    0,
    Math.min(maxIterations, Math.floor(params.initialIteration ?? 0))
  );

  emit({
    type: "goal_started",
    goal: options.goal,
    criteria: options.criteria,
    maxIterations,
  });
  while (iteration < maxIterations && !shouldStop?.()) {
    iteration += 1;
    emit({ type: "goal_iteration", iteration, maxIterations });
    const output = await execute(
      buildGoalPrompt(options, reviews.at(-1)),
      iteration
    );
    if (shouldStop?.()) {
      status = "cancelled";
      break;
    }
    const review = await evaluator(options.goal, options.criteria, output);
    reviews.push(review);
    emit({ type: "goal_reviewed", iteration, ...review });
    if (review.complete) {
      status = "completed";
      break;
    }
    if (review.blocked) {
      blocker = review.remainingTasks?.[0] ?? review.critique;
      break;
    }
  }
  if (shouldStop?.()) status = "cancelled";

  const blocked = status === "max_iterations" && blocker !== undefined;
  const summary =
    status === "completed"
      ? `Goal completed after ${iteration} verified checkpoint(s).`
      : status === "cancelled"
        ? `Goal cancelled after ${iteration} checkpoint(s).`
        : blocked
          ? `Goal blocked at checkpoint ${iteration}: it needs a decision or change from you.`
          : `Goal reached its ${maxIterations}-checkpoint limit without verified completion.`;
  emit({ type: "goal_completed", status, totalIterations: iteration, summary });
  return {
    status,
    complete: status === "completed",
    ...(blocked ? { blocked, blocker } : {}),
    iterations: iteration,
    summary,
    reviews,
  };
}

function clampIterations(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(50, Math.floor(value as number)));
}
