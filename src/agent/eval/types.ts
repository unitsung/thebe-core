export type AcceptMode = "off" | "observe" | "auto";

/** One rule the person wrote in plain words, e.g. "Restart a media server that stopped, but not at night". */
export type PolicyRule = { id: string; text: string };

/**
 * Read-only work done before an Assessment. It is evidence for the same Decision, never an authorization:
 * observations and suggestions are data, and any write still follows the Ticket's normal Mandate.
 */
export type SpeculativePreparation = {
  source: string;
  observedAt: string;
  resource?: { kind: string; id: string };
  diagnosis?: {
    code: string;
    title: string;
    summary: string;
    confidence: "low" | "medium" | "high";
  };
  observations: Array<{
    kind: string;
    severity: string;
    fact: string;
  }>;
  suggestions: Array<{
    title: string;
    detail: string;
    kind: "read" | "write";
    requiresApproval: boolean;
  }>;
};

export type Policy = {
  rules: PolicyRule[];
  /**
   * `off`: Core watches and records, and never weighs a Trigger. `observe` (the default): Core weighs each
   * one against the rules and records what it WOULD have taken on, and takes on nothing. `auto` takes it on:
   * the rules decide, and a positive assessment becomes a Ticket that an executor carries out under its
   * Mandate. Nothing acts until the person picks `auto`: the default is `observe`.
   */
  acceptMode: AcceptMode;
  /** The model that weighs Triggers. Unset: Core's default model. A cheap one is the point. */
  model?: { providerId: string; modelId: string };
  /** Counts up on every change; the version below is what a Decision records. */
  revision: number;
  updatedAt: string;
};

export type DecisionOutcome = "accept" | "stop" | "ignore" | "unavailable";

/**
 * What Eval decided about the Triggers on one thread. In `observe` a positive assessment is recorded as
 * `ignore` with `wouldAccept`, so the person can see what Core would have done before it is allowed to.
 * In `auto`, `accept` is a Decision that was taken on: it has a Ticket (and the Goal that carries it out). A
 * positive assessment that was not taken on stays `ignore` with `wouldAccept` and `notTakenOn` saying why.
 * `stop` is not produced: it has no agreed meaning.
 */
/** Why a positive assessment in `auto` was not taken on. */
export type NotTakenOn =
  | "thread_limit"
  | "quiesced"
  | "no_executor"
  | "accept_failed";

export type Decision = {
  id: string;
  evalId: string;
  thread: string;
  triggerIds: string[];
  /** When the newest Trigger happened; part of the id, so a re-run gives the same Decision. */
  at: string;
  outcome: DecisionOutcome;
  wouldAccept?: boolean;
  matchedRuleIds: string[];
  /** The rules as they read when this Decision was made, so a later person can act on it after Policy edits. */
  matchedRules?: PolicyRule[];
  /** Assessment's one-sentence description of the work a positive Decision proposes. */
  intent?: string;
  reason: string;
  /** Why no assessment was made or it failed: a Gate reason, a limit, a timeout, or a bad reply. */
  unavailableReason?: string;
  /** The Gate stopped it before any model was asked. */
  gate?: boolean;
  /** Explicit human re-evaluations whose fresh Assessment this Decision answered. */
  requeueIds?: string[];
  /** `auto`, accepted: the Ticket that was made. Its Mandate says what it may do. */
  ticketId?: string;
  /** `auto`, accepted: the Goal that carries the Ticket out. */
  goalId?: string;
  /** Derived on product reads when any Ticket, including a person-accepted one, links this Decision. */
  acceptedTicketId?: string;
  /**
   * `auto`, a positive assessment that was not taken on, and why: `thread_limit` (the cap on how often one
   * thread is taken on in an hour), `quiesced`, `no_executor`, or `accept_failed`.
   */
  notTakenOn?: NotTakenOn;
  policyVersion: string;
  decidedAt: string;
};
