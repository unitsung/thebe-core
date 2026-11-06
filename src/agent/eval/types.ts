export type AcceptMode = "off" | "observe" | "auto";

/** One rule the person wrote in plain words, e.g. "Restart a media server that stopped, but not at night". */
export type PolicyRule = { id: string; text: string };

export type Policy = {
  rules: PolicyRule[];
  /**
   * `off`: Core watches and records, and never weighs a Trigger. `observe` (the default): Core weighs each
   * one against the rules and records what it WOULD have taken on, and takes on nothing. `auto` takes it on:
   * a stopped container on `autoContainers` is restarted directly (within a breaker), any other is only
   * diagnosed, which asks the person. `auto` needs the host to allow it (`THEBE_EVAL_AUTO`).
   */
  acceptMode: AcceptMode;
  /**
   * The containers (by name) `auto` may restart without asking. A hard cap the model cannot widen: what is
   * not listed is only diagnosed. Empty means no direct restart at all.
   */
  autoContainers?: string[];
  /** The model that weighs Triggers. Unset: Core's default model. A cheap one is the point. */
  model?: { providerId: string; modelId: string };
  /** Counts up on every change; the version below is what a Decision records. */
  revision: number;
  updatedAt: string;
};

export type DecisionOutcome = "accept" | "stop" | "ignore" | "unavailable";

/** What `auto` did about a Decision that was worth taking on. Set only in `auto`. */
export type DecisionAction = {
  /** `restart`: a stopped container was restarted. `diagnose`: handed to the person. `none`: nothing done. */
  kind: "restart" | "diagnose" | "none";
  /**
   * restart: the receipt's status (`succeeded`, `failed`, `provider_unavailable`). diagnose:
   * `awaiting_approval` or `no_restart_advised`. none: why (`stale`, `already_up`, `not_down_event`,
   * `container_not_found`, `container_ambiguous`, `quiesced`, `auto_disabled`, `act_failed`, ...).
   */
  status: string;
  note: string;
  container?: string;
  /** The restart's receipt, to read what was verified. */
  receiptId?: string;
};

/**
 * What Eval decided about the Triggers on one thread. In `observe` a positive assessment is recorded as
 * `ignore` with `wouldAccept`, so the person can see what Core would have done before it is allowed to.
 * In `auto`, `accept` is a Decision that was acted on (a restart done, or the person asked); a positive
 * assessment that was not acted on stays `ignore` with `wouldAccept` and an `action` that says why. `stop`
 * is not produced: it has no agreed meaning.
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
  /** `auto` only: what was done about a positive assessment. */
  action?: DecisionAction;
  policyVersion: string;
  decidedAt: string;
};
