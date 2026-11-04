import type { ActivityStage } from "../activity/stage.ts";

/** Explicit when the owner asked for the work; inferred when Thebe started it itself. */
export type TicketStrength = "explicit" | "inferred";

/**
 * The existing objects a ticket wraps. They keep their own ids and their single writer (the goal
 * runner owns goal progress, the activity store owns receipts); the ticket only points at them.
 */
export type TicketLinks = {
  /** The goal loop that does the work. Its id is the parent `thebeSessionId`. */
  legacyGoalId?: string;
  /** When that goal run started. A session can run several goals one after another; this says which. */
  legacyGoalStartedAt?: string;
  sessionIds: string[];
  capabilityRunIds: string[];
  receiptIds: string[];
  artifactIds: string[];
  pipelineJobIds: string[];
};

/**
 * The unit of authorised work. Its id is derived from its content, so the same trigger accepted twice
 * yields the same ticket. Stored once and never rewritten; progress is read from the wrapped objects.
 */
export type Ticket = {
  id: string;
  title: string;
  createdAt: string;
  /** Grows into the full mandate (policy version, scope, matched rules) with the mandate work. */
  mandate: { strength: TicketStrength };
  /** How the ticket was accepted: a direct decision on a trigger from `thread`. */
  origin: { kind: "direct"; thread: string; triggerId: string };
  links: TicketLinks;
};

/** A ticket as the collection returns it. The stage is derived on every read and never stored. */
export type TicketView = Ticket & { stage: ActivityStage };

/** Lookup from a wrapped object to the ticket that wraps it; used to put `ticketId` on responses. */
export type TicketIndex = ReadonlyMap<string, string>;

/** The key under which the index holds the ticket that wraps one run of a goal. */
export function goalTicketKey(sessionId: string, startedAt: string): string {
  return `goal:${sessionId}:${startedAt}`;
}
