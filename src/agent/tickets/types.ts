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
   * Eval only: what the Ticket is allowed to touch, as `action:target` (for example `container.restart:emby`).
   * It is the person's own list, narrowed to this one container. Anything outside it is not authorised.
   */
  scope?: string[];
};

export type TicketLinks = {
  /** The Goal that carries the work out. Its id is the session id. */
  legacyGoalId?: string;
  sessionIds: string[];
  /** The Decision that took the work on. */
  decisionId?: string;
  /** Receipts of actions taken under this Ticket (a restart), to read what was done and verified. */
  receiptIds?: string[];
};

export type Ticket = {
  id: string;
  title: string;
  mandate: TicketMandate;
  /** Thread keys this Ticket follows, e.g. `chat:<sessionId>` or `resource:container:emby`. */
  subscriptions: string[];
  links: TicketLinks;
  createdAt: string;
};
