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
  /** Where the request came from, e.g. `chat`. */
  requester: string;
};

export type TicketLinks = {
  /** The Goal that carries the work out. Its id is the session id. */
  legacyGoalId?: string;
  sessionIds: string[];
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
