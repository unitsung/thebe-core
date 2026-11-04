import type { AcceptMode } from "../policy/types.ts";
import type { RuntimeModelRef } from "../runtime/interface.ts";
import type { TriggerRecord } from "../sources/types.ts";

/**
 * What Eval decided about a Trigger that passed the Gate. `accept` is "take it", `stop` ends work on the
 * thread, `ignore` does nothing, `unavailable` is "could not decide" (the model failed, ran out of time or
 * gave an answer Core cannot use).
 */
export const DECISION_RESULTS = [
  "accept",
  "stop",
  "ignore",
  "unavailable",
] as const;
export type DecisionResult = (typeof DECISION_RESULTS)[number];

/** Why no ordinary verdict was reached or no model was asked. */
export const DECISION_REASONS = [
  "mode_off",
  "no_rules",
  "model_error",
  "timeout",
  "invalid_output",
  "interrupted",
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

/** The Assessment's verdict on one rule, in the owner's order. */
export type RuleJudgement = {
  ruleId: string;
  name: string;
  matches: boolean;
  /** The model's own words, clipped. Data to read, never an instruction. */
  reason?: string;
};

export type DecisionTokens = {
  input: number;
  output: number;
  cacheWrite: number;
  /** Reported on its own; not part of the counted total. */
  cacheRead: number;
};

/** Written once per Trigger and never changed. */
export type Decision = {
  triggerId: string;
  result: DecisionResult;
  /** Observe mode: a positive assessment is recorded as `ignore` with this flag, and nothing runs. */
  wouldHaveTaken?: true;
  reason?: DecisionReason;
  mode: AcceptMode;
  /** The policy version the rules and mode came from. */
  policyVersion: number;
  /** The first rule the Assessment found to match; always one of the policy's active rules. */
  matchedRule?: { id: string; name: string };
  judgements?: RuleJudgement[];
  model?: RuntimeModelRef;
  /** The read-only tools whose output went to the model as context. */
  diagnostics?: string[];
  /** Background tokens this assessment used. */
  tokens?: DecisionTokens;
  decidedAt: string;
};

/** A Trigger with its Gate outcome and, once Eval has finished with it, the Decision. */
export type TriggerEntry = TriggerRecord & { decision?: Decision };
