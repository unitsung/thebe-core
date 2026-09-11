import type { NormalizedEvent, PromptMode } from "../runtime/types.ts";

export type ThebePromptResult = {
  text: string;
  tools: string[];
  events: NormalizedEvent[];
  thebeSessionId: string;
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
