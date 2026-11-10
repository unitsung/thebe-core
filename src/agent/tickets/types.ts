/**
 * A Ticket wraps one authorised unit of work. It owns only the domain layer: who asked, under what
 * authority, which thread it follows, and which existing objects carry it out. The Goal keeps its own
 * progress, report and attention; the Ticket's stage is derived from them, never stored here.
 */
export type TicketStrength = "explicit" | "inferred";

export type TicketMandate = {
  strength: TicketStrength;
  /** How the work was accepted: a person asked (`direct`), or Eval weighed a Trigger (`eval`). */
  decidedBy: "direct" | "eval";
  /** The Eval that produced this Ticket; the Ticket id derives from it. */
  evalId: string;
  /** Where the request came from, e.g. `chat`, or the Source that raised the Trigger. */
  requester: string;
  /** Eval only: the version of the policy it was taken on under, so the rules in force can be told. */
  policyVersion?: string;
  /** Eval only: the rules that matched. */
  matchedRuleIds?: string[];
  /**
   * Eval only: what the Ticket is allowed to touch, as `service:write` (for example `docker:write`): the
   * services that look after what the event is about. Anything outside it, and anything irreversible, is
   * not authorised.
   */
  scope?: string[];
  /** Eval only: what the work is, in the assessment's own one sentence. */
  intent?: string;
};

/**
 * One later event on a subscribed thread handed to the ticket as an input without a new evaluation.
 */
export type TicketInput = {
  triggerId: string;
  seq: number;
  source: string;
  kind: string;
  thread: string;
  at: string;
  attachedAt: string;
  /** Optional routing note from the person when the main Session attached this event explicitly. */
  note?: string;
  payload?: Record<string, unknown>;
};

export type TicketLinks = {
  /** The Goal that carries the work out. Its id is the session id. */
  legacyGoalId?: string;
  /** The caller's stable key for a delegated request. */
  requestId?: string;
  sessionIds: string[];
  /** The Decision that took the work on. */
  decisionId?: string;
};

export type Ticket = {
  id: string;
  title: string;
  mandate: TicketMandate;
  /** Thread keys this Ticket follows, e.g. `chat:<sessionId>` or `resource:container:emby`. */
  subscriptions: string[];
  /** Events on subscribed threads attached while the Ticket is open. */
  inputs: TicketInput[];
  links: TicketLinks;
  createdAt: string;
};
