export type AcceptMode = "off" | "observe";

/** One rule the person wrote in plain words, e.g. "Restart a media server that stopped, but not at night". */
export type PolicyRule = { id: string; text: string };

export type Policy = {
  rules: PolicyRule[];
  /**
   * `off`: Core watches and records, and never weighs a Trigger. `observe` (the default): Core weighs each
   * one against the rules and records what it WOULD have taken on, and takes on nothing. `auto` (take it on
   * and act within a Mandate) does not exist yet.
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
 * `accept` and `stop` are not produced yet: there is no auto mode to accept into, and `stop` has no
 * agreed meaning.
 */
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
  reason: string;
  /** Why no assessment was made or it failed: a Gate reason, a limit, a timeout, or a bad reply. */
  unavailableReason?: string;
  /** The Gate stopped it before any model was asked. */
  gate?: boolean;
  policyVersion: string;
  decidedAt: string;
};
