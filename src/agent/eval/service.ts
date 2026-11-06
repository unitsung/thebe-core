import { key } from "../tickets/ids.ts";
import type { Trigger } from "../sources/types.ts";
import { buildAssessmentPrompt, parseAssessment } from "./assess.ts";
import type { DecisionStore } from "./decision-store.ts";
import { policyVersion, type PolicyStore } from "./policy-store.ts";
import type { Decision, Policy } from "./types.ts";

/** The kinds of change worth weighing. A pause or an unlisted state change is noise. */
export const ASSESSED_KINDS: ReadonlySet<string> = new Set([
  "container.went_down",
  "container.recovered",
  "container.removed",
  "container.appeared",
]);

export const DEFAULT_ASSESSMENTS_PER_HOUR = 20;
/** Triggers older than this are not weighed after a restart: the moment to act has passed. */
export const DEFAULT_BACKLOG_AGE_MS = 24 * 60 * 60 * 1000;

export type EvalService = {
  /** Triggers just recorded. Weighed one thread at a time. Never throws. */
  enqueue(triggers: readonly Trigger[]): void;
  /** After a start: weigh recorded Triggers that no Decision covers yet. */
  recover(triggers: readonly Trigger[]): void;
  /** Resolves when everything queued so far has been decided. */
  idle(): Promise<void>;
  stop(): void;
  start(): void;
};

export function createEvalService(options: {
  policy: PolicyStore;
  decisions: DecisionStore;
  /** What the enabled Sources are, folded into the policy version. */
  sources: string;
  /** Asks the model; returns its raw reply. Rejects on a timeout or provider failure. */
  assess: (prompt: string, model: Policy["model"]) => Promise<string>;
  now: () => Date;
  maxPerHour?: number;
  backlogAgeMs?: number;
  onError?: (error: unknown) => void;
}): EvalService {
  const maxPerHour = options.maxPerHour ?? DEFAULT_ASSESSMENTS_PER_HOUR;
  const backlogAgeMs = options.backlogAgeMs ?? DEFAULT_BACKLOG_AGE_MS;
  const pending = new Map<string, Trigger[]>();
  const assessedAt: number[] = [];
  let draining: Promise<void> | undefined;
  let stopped = false;

  function queue(triggers: readonly Trigger[]): void {
    if (stopped) return;
    for (const trigger of triggers) {
      for (const thread of trigger.threads) {
        const list = pending.get(thread) ?? [];
        if (!list.some((row) => row.id === trigger.id)) list.push(trigger);
        pending.set(thread, list);
      }
    }
    if (!draining) {
      draining = drain().finally(() => {
        draining = undefined;
        // Something may have been queued while the last round was finishing.
        if (pending.size > 0 && !stopped) queue([]);
      });
    }
  }

  // At most one Eval runs at a time, and every Trigger that queued on a thread meanwhile is weighed
  // together in the next one, so a container that flaps costs one question, not one per flip.
  async function drain(): Promise<void> {
    while (!stopped && pending.size > 0) {
      const [thread, triggers] = pending.entries().next().value as [
        string,
        Trigger[],
      ];
      pending.delete(thread);
      try {
        await decide(thread, triggers);
      } catch (error) {
        options.onError?.(error);
      }
    }
  }

  async function decide(thread: string, all: Trigger[]): Promise<void> {
    const decided = await options.decisions.decidedTriggerIds();
    const triggers = all
      .filter((row) => !decided.has(row.id))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    if (triggers.length === 0) return;

    const policy = await options.policy.get();
    const version = policyVersion(policy, options.sources);
    const latest = triggers[triggers.length - 1]!.at;
    const triggerIds = triggers.map((row) => row.id);
    // Built from the Triggers' own times, never the clock: a re-run after a crash is the same Decision.
    const evalId = key("eval", thread, version, latest, ...triggerIds);
    const base = {
      id: key("decision", evalId),
      evalId,
      thread,
      triggerIds,
      at: latest,
      policyVersion: version,
      decidedAt: options.now().toISOString(),
    };
    const record = (
      rest: Pick<Decision, "outcome" | "reason"> & Partial<Decision>
    ) => options.decisions.add({ matchedRuleIds: [], ...base, ...rest });

    // Gate: deterministic, no model.
    if (policy.acceptMode === "off") {
      await record({
        outcome: "ignore",
        gate: true,
        reason: "accept mode is off",
        unavailableReason: "mode_off",
      });
      return;
    }
    if (policy.rules.length === 0) {
      await record({
        outcome: "ignore",
        gate: true,
        reason: "no rules are set",
        unavailableReason: "no_rules",
      });
      return;
    }
    if (!triggers.some((row) => ASSESSED_KINDS.has(row.kind))) {
      await record({
        outcome: "ignore",
        gate: true,
        reason: "this kind of change is not weighed",
        unavailableReason: "kind_not_assessed",
      });
      return;
    }
    const hourAgo = options.now().getTime() - 60 * 60 * 1000;
    while (assessedAt.length > 0 && assessedAt[0]! < hourAgo)
      assessedAt.shift();
    if (assessedAt.length >= maxPerHour) {
      await record({
        outcome: "unavailable",
        gate: true,
        reason: "too many assessments this hour",
        unavailableReason: "assessment_limit",
      });
      return;
    }

    // Assessment. A failure is never a "no": it is recorded as unavailable.
    assessedAt.push(options.now().getTime());
    let reply: string;
    try {
      reply = await options.assess(
        buildAssessmentPrompt(policy.rules, triggers),
        policy.model
      );
    } catch (error) {
      await record({
        outcome: "unavailable",
        reason: "the assessment could not be made",
        unavailableReason:
          error instanceof Error
            ? error.message.slice(0, 200)
            : "assessment failed",
      });
      return;
    }
    const verdict = parseAssessment(reply, policy.rules);
    if (!verdict) {
      await record({
        outcome: "unavailable",
        reason: "the model did not answer in the agreed form",
        unavailableReason: "unparseable_reply",
      });
      return;
    }
    // observe: a positive assessment is what Core WOULD have taken on; it takes on nothing.
    await record({
      outcome: "ignore",
      wouldAccept: verdict.decision === "accept",
      matchedRuleIds: verdict.matchedRuleIds,
      reason: verdict.reason,
    });
  }

  return {
    enqueue: queue,
    recover(triggers) {
      const cutoff = options.now().getTime() - backlogAgeMs;
      void options.decisions.decidedTriggerIds().then((decided) => {
        queue(
          triggers
            .filter(
              (row) => !decided.has(row.id) && Date.parse(row.at) >= cutoff
            )
            .sort((a, b) => (a.at < b.at ? -1 : 1))
            .slice(-maxPerHour)
        );
      });
    },
    async idle() {
      while (draining) await draining;
    },
    stop() {
      stopped = true;
    },
    start() {
      stopped = false;
    },
  };
}
