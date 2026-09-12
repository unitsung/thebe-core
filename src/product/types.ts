import type { NormalizedEvent, PromptMode } from "../runtime/types.ts";

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

/**
 * Control-plane record for an ephemeral subagent invocation.
 *
 * This is deliberately not a ProductSessionMeta: a subagent has no resumable
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
  result?: string;
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
