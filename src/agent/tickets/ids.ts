import { createHash } from "node:crypto";

/** Content-derived id: sha256 of the parts, 32 hex characters. */
export function contentKey(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * A ticket is created by a decision on a trigger. A trigger is immutable and its id already names the
 * event, so the same trigger accepted twice derives the same eval, decision and ticket.
 */
export function directTicketId(thread: string, triggerId: string): string {
  const evalId = contentKey("eval", thread, "direct", triggerId, "explicit");
  return contentKey("ticket", evalId);
}

/** Thread and trigger for a goal started with a trigger id the caller chose (chat message, request id). */
export function chatTrigger(triggerId: string) {
  return { thread: "chat", triggerId: `client:${triggerId}` };
}

/** Thread and trigger for a goal started without one: the run itself is the trigger. */
export function runTrigger(sessionId: string, startedAt: string) {
  return { thread: `session:${sessionId}`, triggerId: `goal:${startedAt}` };
}
