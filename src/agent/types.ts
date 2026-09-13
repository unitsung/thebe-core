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
  | "cancelled";

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

export type GoalRun = {
  thebeSessionId: string;
  goal: string;
  criteria?: string[];
  maxIterations: number;
  iteration: number;
  status: GoalRunStatus;
  createdAt: string;
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
  error?: string;
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
  code?: string,
): Error {
  return Object.assign(new Error(message), { status, code });
}
