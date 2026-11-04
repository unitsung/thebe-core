import { hashParameters } from "../security/audit/audit-log.ts";
import type { createAuditLog } from "../security/audit/audit-log.ts";
import type { PolicyView } from "../policy/types.ts";
import type {
  AgentRuntime,
  RuntimeModelRef,
  RuntimeSession,
} from "../runtime/interface.ts";
import type { Trigger, TriggerRecord } from "../sources/types.ts";
import {
  ASSESSMENT_SYSTEM_PROMPT,
  buildAssessmentPrompt,
  parseAssessment,
} from "./assessment.ts";
import type { AssessmentContext } from "./context.ts";
import { createDecisionStore } from "./decision-store.ts";
import type {
  Decision,
  DecisionReason,
  DecisionTokens,
  TriggerEntry,
} from "./types.ts";

export const DEFAULT_ASSESSMENT_TIMEOUT_MS = 60_000;

export type EvalService = {
  /** Assesses one Trigger that passed the Gate and records its Decision. Never throws. */
  evaluate(trigger: Trigger): Promise<void>;
  /** Triggers that passed the Gate, joined with their Decision when there is one. */
  join(records: TriggerRecord[]): Promise<TriggerEntry[]>;
  listDecisions(): Promise<Decision[]>;
  /**
   * Gives every passed Trigger that has no Decision (its evaluation was cut off by a restart) a
   * could-not-decide Decision. It never asks the model again, so a restart costs no tokens.
   */
  settleInterrupted(records: TriggerRecord[]): Promise<void>;
};

/**
 * Eval's second layer. For a Trigger past the Gate it reads the policy once, asks the model (a cheaper
 * background model when the policy names one) to judge each active rule, and records exactly one
 * Decision carrying the policy version and the rule that matched.
 *
 * The model has no tools. The policy is read, never written: event text and model output have no path to
 * it, and the rule the answer names must be one of the rules that were asked about.
 *
 * Observe mode turns a positive answer into `ignore` with `wouldHaveTaken`. Nothing here executes a write
 * or creates a confirmation in any mode; acting on an `accept` belongs to the ticket work that follows.
 * A failure of any kind is recorded as `unavailable` and is not retried.
 */
export function createEvalService(options: {
  dir?: string;
  now: () => Date;
  runtime: AgentRuntime;
  /** The model used when the policy names none. */
  defaultModel?: RuntimeModelRef;
  getPolicy: () => Promise<PolicyView>;
  collectContext: (trigger: Trigger) => Promise<AssessmentContext>;
  audit?: ReturnType<typeof createAuditLog>;
  timeoutMs?: number;
}): EvalService {
  const store = createDecisionStore({ dir: options.dir });
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASSESSMENT_TIMEOUT_MS;
  let decisions: Promise<Map<string, Decision>> | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  function load() {
    decisions ??= store
      .load()
      .then((list) => new Map(list.map((item) => [item.triggerId, item])));
    return decisions;
  }

  /** Writes are one at a time, and a Trigger gets its first Decision only. */
  function record(decision: Decision): Promise<void> {
    const run = chain.then(async () => {
      const known = await load();
      if (known.has(decision.triggerId)) return;
      await store.append(decision);
      known.set(decision.triggerId, decision);
    });
    chain = run.catch(() => undefined);
    return run;
  }

  async function assess(
    trigger: Trigger,
    policy: PolicyView
  ): Promise<
    Omit<Decision, "triggerId" | "mode" | "policyVersion" | "decidedAt">
  > {
    if (policy.mode === "off") return { result: "ignore", reason: "mode_off" };
    const rules = policy.activeRules;
    if (rules.length === 0) return { result: "ignore", reason: "no_rules" };

    const model = policy.backgroundModel ?? options.defaultModel;
    const unavailable = (
      reason: DecisionReason,
      extra: Partial<Decision> = {}
    ) => ({
      result: "unavailable" as const,
      reason,
      ...(model ? { model } : {}),
      ...extra,
    });

    let context: AssessmentContext = { text: "", tools: [] };
    try {
      context = await options.collectContext(trigger);
    } catch {
      // Assess without diagnostics.
    }
    const diagnostics = context.tools.length
      ? { diagnostics: context.tools }
      : {};

    let session: RuntimeSession | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tokens: DecisionTokens | undefined;
    try {
      session = await options.runtime.createSession({
        ...(model ? { model } : {}),
        customTools: [],
        builtinTools: [],
        systemPrompt: ASSESSMENT_SYSTEM_PROMPT,
        autoCompact: false,
        inMemory: true,
      });
      let failure: string | undefined;
      session.subscribe((event) => {
        if (event.type === "error") failure = event.message;
      });
      const prompting = session.prompt(
        buildAssessmentPrompt({ rules, trigger, context: context.text })
      );
      prompting.catch(() => undefined);
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      });
      const outcome = await Promise.race([
        prompting.then(
          () => "done" as const,
          () => "failed" as const
        ),
        timedOut,
      ]);
      tokens = await readTokens(session);
      const withTokens = tokens ? { tokens } : {};
      if (outcome === "timeout") {
        await session.abort().catch(() => undefined);
        return unavailable("timeout", { ...diagnostics, ...withTokens });
      }
      if (outcome === "failed" || failure !== undefined) {
        return unavailable("model_error", { ...diagnostics, ...withTokens });
      }
      const parsed = parseAssessment(session.lastAssistantText(), rules);
      if (!parsed) {
        return unavailable("invalid_output", { ...diagnostics, ...withTokens });
      }
      const base = {
        judgements: parsed.judgements,
        ...(parsed.matched
          ? {
              matchedRule: { id: parsed.matched.id, name: parsed.matched.name },
            }
          : {}),
        ...(model ? { model } : {}),
        ...diagnostics,
        ...withTokens,
      };
      // Observe never takes anything: a positive answer is only remembered as one it would have taken.
      if (parsed.decision === "accept" && policy.mode === "observe") {
        return { result: "ignore", wouldHaveTaken: true, ...base };
      }
      return { result: parsed.decision, ...base };
    } catch {
      return unavailable("model_error", {
        ...diagnostics,
        ...(tokens ? { tokens } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
      try {
        session?.dispose();
      } catch {
        // Nothing left to release.
      }
    }
  }

  return {
    async evaluate(trigger) {
      try {
        if ((await load()).has(trigger.id)) return;
        const policy = await options.getPolicy();
        const outcome = await assess(trigger, policy);
        const decision: Decision = {
          triggerId: trigger.id,
          ...outcome,
          mode: policy.mode,
          policyVersion: policy.version,
          decidedAt: options.now().toISOString(),
        };
        await record(decision);
        await options.audit
          ?.append({
            method: "eval.assess",
            parameterHash: hashParameters({ triggerId: trigger.id }),
            responseBytes: 0,
            budgetConsumed: decision.tokens
              ? decision.tokens.input +
                decision.tokens.output +
                decision.tokens.cacheWrite
              : 0,
            redactionFired: false,
            result: decision.result === "unavailable" ? "error" : "ok",
          })
          .catch(() => undefined);
      } catch {
        // The policy or the store could not be read: nothing safe to record, and no retry loop.
      }
    },
    async join(records) {
      const known = await load();
      return records.map((item) => {
        const decision = known.get(item.trigger.id);
        return decision ? { ...item, decision } : item;
      });
    },
    async listDecisions() {
      return [...(await load()).values()];
    },
    async settleInterrupted(records) {
      try {
        const known = await load();
        const waiting = records.filter(
          (item) =>
            item.outcome.result === "passed" && !known.has(item.trigger.id)
        );
        if (waiting.length === 0) return;
        const policy = await options.getPolicy();
        for (const item of waiting) {
          await record({
            triggerId: item.trigger.id,
            result: "unavailable",
            reason: "interrupted",
            mode: policy.mode,
            policyVersion: policy.version,
            decidedAt: options.now().toISOString(),
          });
        }
      } catch {
        // Try again on the next start.
      }
    },
  };
}

async function readTokens(
  session: RuntimeSession
): Promise<DecisionTokens | undefined> {
  try {
    const stats = (await session.getContextUsage()).sessionStats?.tokens;
    if (!stats) return undefined;
    return {
      input: stats.input,
      output: stats.output,
      cacheWrite: stats.cacheWrite,
      cacheRead: stats.cacheRead,
    };
  } catch {
    return undefined;
  }
}
