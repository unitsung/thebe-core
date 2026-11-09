import { createHash } from "node:crypto";

/**
 * A content-derived id: sha256 of the parts, cut to 32 hex characters. The same inputs always give the
 * same id, so seeing the same Trigger twice yields the same Ticket. The parts are hashed as JSON, not
 * joined, so ("a", "bc") and ("ab", "c") cannot collide.
 */
export function key(...values: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 32);
}

/** A direct Decision: the person asked for the work themselves (Eval does not weigh it). */
export function directEvalId(input: {
  thread: string;
  triggerId: string;
  kind: string;
  at: string;
  /** A stable request key replaces time in the id, so retrying a delegated request is idempotent. */
  idempotencyKey?: string;
}): string {
  return key(
    "eval",
    input.thread,
    "direct",
    input.triggerId,
    input.kind,
    input.idempotencyKey ?? input.at
  );
}

export function ticketIdFor(evalId: string): string {
  return key("ticket", evalId);
}

/** The Ticket a delegated request would create, before any execution state exists. */
export function directTicketId(input: {
  thread: string;
  triggerId: string;
  kind: string;
  at: string;
  idempotencyKey: string;
}): string {
  return ticketIdFor(directEvalId(input));
}
