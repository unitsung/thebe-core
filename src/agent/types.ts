import type { NormalizedEvent, PromptMode } from "./runtime/index.ts";

export type ThebePromptResult = {
  text: string;
  tools: string[];
  events: NormalizedEvent[];
  thebeSessionId: string;
};

export type SubagentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type SubagentUpdate = {
  run: SubagentRun;
  event?: NormalizedEvent;
};

export type SubagentActivityKind =
  | "status"
  | "thinking"
  | "tool"
  | "approval"
  | "response"
  | "error";

export type SubagentActivityPhase =
  | "started"
  | "running"
  | "completed"
  | "failed";

export type SubagentActivityDetailKind = "input" | "progress" | "output";

/** Bounded, UI-safe progress retained after the ephemeral runtime is disposed. */
export type SubagentActivity = {
  id: number;
  at: string;
  kind: SubagentActivityKind;
  title: string;
  /** Correlates one tool's start/update/end events for compact rendering. */
  toolCallId?: string;
  toolName?: string;
  phase?: SubagentActivityPhase;
  /** Retained tool input, progress, and final output for one tool call. */
  input?: string;
  progress?: string;
  output?: string;
  /** @deprecated Read detail through input/progress/output when possible. */
  detailKind?: SubagentActivityDetailKind;
  /** @deprecated Read detail through input/progress/output when possible. */
  detail?: string;
};

/**
 * Control-plane record for an ephemeral subagent invocation.
 *
 * This is deliberately not a AgentSessionMeta: a subagent has no resumable
 * transcript and is never added to the ordinary session store.
 */
export type SubagentRun = {
  runId: string;
  parentSessionId: string;
  profileName: string;
  task: string;
  status: SubagentRunStatus;
  turns: number;
  maxTurns: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Live assistant output, retained so a completed child remains inspectable. */
  responseText?: string;
  /** Bounded product Artifact containing terminal worker evidence. */
  artifactId?: string;
  /** Bounded lifecycle/tool/reasoning summary; never contains full tool results. */
  activity?: SubagentActivity[];
  result?: string;
  error?: string;
};

/** A durable-objective run attached to one ordinary parent conversation. */
export type GoalRunStatus =
  | "running"
  | "pausing"
  | "paused"
  | "completed"
  | "max_iterations"
  | "cancelled"
  | "failed";

/** What a Goal's worker said about a checkpoint through `goal_report`. */
export type GoalReportState =
  | "progress"
  | "ready"
  | "blocked"
  | "waiting"
  | "ask"
  | "dropped";

export type GoalReport = {
  state: GoalReportState;
  summary?: string;
  evidence?: string;
  blocker?: string;
  question?: string;
  options?: string[];
  reason?: string;
  at: string;
};

/** The one open request for the person on a Goal: a question to answer, or a finished result to accept. */
export type GoalAttention = {
  id: string;
  kind: "answer" | "review";
  question: string;
  options?: string[];
  askedAt: string;
};

export type GoalRun = {
  thebeSessionId: string;
  goal: string;
  criteria?: string[];
  maxIterations: number;
  iteration: number;
  status: GoalRunStatus;
  createdAt: string;
  updatedAt?: string;
  subagentRunIds: string[];
  activeSubagent?: SubagentRun;
  lastReview?: {
    score: number;
    critique: string;
    remainingTasks?: string[];
  };
  finishedAt?: string;
  summary?: string;
  /** The latest isolated worker/reviewer report for the parent to inspect. */
  finalReport?: string;
  /** Bounded product Artifact containing the latest terminal report. */
  artifactId?: string;
  error?: string;
  /** Ended `failed` because the review reported a blocker that only the person can clear. */
  blocked?: boolean;
  /** Read-only run: the worker cannot edit, write or run commands, only look and report. */
  observe?: boolean;
  /**
   * Who carries the work out. Unset: the coding worker, for a task in the workspace. `ticket`: the home
   * operator, for work an Eval took on (a Ticket): it has the home tools, not a shell or file editing, and
   * what it may change is what the Ticket's Mandate allows.
   */
  executor?: "ticket";
  /** The worker's latest structured report. */
  report?: GoalReport;
  /** Set while the Goal is paused waiting for the person; cleared by their answer. */
  attention?: GoalAttention;
  /** The task opted in to the worker asking the person a question mid-run. */
  allowAsk?: boolean;
  /** After the independent review passes, wait for the person to accept instead of finishing. */
  reviewBeforeDone?: boolean;
  /** The person's answers and review notes so far, given to every later checkpoint. */
  guidance?: string[];
};

/** @deprecated Use ThebePromptResult */
export type ThebeReply = ThebePromptResult;

export type ThebePromptOptions = {
  thebeSessionId?: string;
  mode?: PromptMode;
  /** Auto-deny pending tool approvals instead of waiting (JSON /v1/messages). */
  nonInteractive?: boolean;
};

/**
 * Coarse run state for UI rendering. `interrupted` is a transient event, not
 * a state: after an abort the session returns to `idle`.
 */
export type SessionRunStatus = "idle" | "running" | "awaiting_permission";

/** Default ceiling for a model connectivity probe. */
export const DEFAULT_MODEL_TEST_TIMEOUT_MS = 60_000;

/** Error with an HTTP status hint for the thin Serve layer. */
export function httpError(
  status: number,
  message: string,
  code?: string
): Error {
  return Object.assign(new Error(message), { status, code });
}
