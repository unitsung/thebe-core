import { key } from "../tickets/ids.ts";
import type { Trigger } from "../sources/types.ts";
import {
  buildAssessmentPrompt,
  MAX_REASON_CHARS,
  parseAssessment,
  type Assessment,
  type ThreadTicket,
} from "./assess.ts";
import type { DecisionStore } from "./decision-store.ts";
import { policyVersion, type PolicyStore } from "./policy-store.ts";
import type { Decision, NotTakenOn, Policy } from "./types.ts";

/** The kinds of change worth weighing. A pause or an unlisted state change is noise. */
export const ASSESSED_KINDS: ReadonlySet<string> = new Set([
  "container.went_down",
  "container.recovered",
  "container.removed",
  "container.appeared",
  "download.completed",
]);

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_ASSESSMENTS_PER_HOUR = 60;
/** How often one thread may be taken on in an hour. The next one is left to the person, and recorded. */
export const DEFAULT_ACCEPTS_PER_THREAD_PER_HOUR = 3;
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

export type EvalUnavailableNotice = {
  /** Stable for this Decision, so the push outbox and relay deduplicate a retry. */
  id: string;
  decisionId: string;
  thread: string;
  at: string;
  unavailableReason: string;
  message: string;
};

export function createEvalService(options: {
  policy: PolicyStore;
  decisions: DecisionStore;
  /** What the enabled Sources are, folded into the policy version. */
  sources: string;
  /** Asks the model; returns its raw reply. Rejects on a timeout or provider failure. */
  assess: (prompt: string, model: Policy["model"]) => Promise<string>;
  now: () => Date;
  /** Questions to the model per hour before the rest are recorded as `assessment_limit`. 0 is no limit. */
  maxPerHour?: number;
  /**
   * What `auto` does with a positive assessment: make the Ticket and hand it to an executor. It is given
   * the Eval's own id, so a Decision made again after a crash gets the same Ticket and not a second.
   */
  accept?: (input: {
    evalId: string;
    decisionId: string;
    thread: string;
    triggers: Trigger[];
    policy: Policy;
    assessment: Assessment;
    at: string;
    policyVersion: string;
  }) => Promise<{ ticketId: string; goalId?: string }>;
  /** Work already taken on for a thread, shown to the assessment so it does not start the same work twice. */
  threadTickets?: (thread: string) => Promise<ThreadTicket[]>;
  /** How often one thread may be taken on in an hour. 0 is no limit. */
  maxAcceptsPerThreadPerHour?: number;
  backlogAgeMs?: number;
  /**
   * Called for the first failed assessment in an outage. A later successful assessment ends the
   * outage, so another failure after recovery is announced once again.
   */
  onUnavailable?: (notice: EvalUnavailableNotice) => Promise<void> | void;
  onError?: (error: unknown) => void;
}): EvalService {
  // A limit of 0 (or less) turns the breaker off; unset keeps the default.
  const configured = options.maxPerHour ?? DEFAULT_ASSESSMENTS_PER_HOUR;
  const maxPerHour = configured > 0 ? configured : Number.POSITIVE_INFINITY;
  const acceptsConfigured =
    options.maxAcceptsPerThreadPerHour ?? DEFAULT_ACCEPTS_PER_THREAD_PER_HOUR;
  const maxAccepts =
    acceptsConfigured > 0 ? acceptsConfigured : Number.POSITIVE_INFINITY;
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
    const recordUnavailable = async (
      reason: string,
      unavailableReason: string
    ) => {
      const decision = await record({
        outcome: "unavailable",
        reason,
        unavailableReason,
      });
      await notifyUnavailable(decision);
    };

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
    const hourAgo = options.now().getTime() - HOUR_MS;
    while (assessedAt.length > 0 && assessedAt[0]! < hourAgo)
      assessedAt.shift();
    if (assessedAt.length >= maxPerHour) {
      const decision = await record({
        outcome: "unavailable",
        gate: true,
        reason: "too many assessments this hour",
        unavailableReason: "assessment_limit",
      });
      await notifyUnavailable(decision);
      return;
    }

    // Assessment. A failure is never a "no": it is recorded as unavailable.
    assessedAt.push(options.now().getTime());
    let reply: string;
    try {
      const earlier =
        (await options.threadTickets?.(thread).catch(() => [])) ?? [];
      reply = await options.assess(
        buildAssessmentPrompt(policy.rules, triggers, earlier),
        policy.model
      );
    } catch (error) {
      await recordUnavailable(
        "the assessment could not be made",
        error instanceof Error
          ? error.message.slice(0, MAX_REASON_CHARS)
          : "assessment failed"
      );
      return;
    }
    const verdict = parseAssessment(reply, policy.rules);
    if (!verdict) {
      await recordUnavailable(
        "the model did not answer in the agreed form",
        "unparseable_reply"
      );
      return;
    }
    const wouldAccept = verdict.decision === "accept";
    if (policy.acceptMode === "auto" && wouldAccept) {
      const positive = {
        wouldAccept: true,
        matchedRuleIds: verdict.matchedRuleIds,
        reason: verdict.reason,
      };
      // A positive assessment that is not taken on stays a "would have", and says why.
      const held = (notTakenOn: NotTakenOn) =>
        record({ outcome: "ignore", ...positive, notTakenOn });
      if (!options.accept) {
        await held("no_executor");
        return;
      }
      // A quiesce that came while the model was thinking still stops it.
      if (stopped) {
        await held("quiesced");
        return;
      }
      const hourStart = options.now().getTime() - HOUR_MS;
      const takenOn = (await options.decisions.list({ thread })).filter(
        (row) =>
          row.outcome === "accept" && Date.parse(row.decidedAt) >= hourStart
      ).length;
      if (takenOn >= maxAccepts) {
        await held("thread_limit");
        return;
      }
      let ticket: { ticketId: string; goalId?: string };
      try {
        ticket = await options.accept({
          evalId,
          decisionId: base.id,
          thread,
          triggers,
          policy,
          assessment: verdict,
          at: latest,
          policyVersion: version,
        });
      } catch (error) {
        options.onError?.(error);
        await held("accept_failed");
        return;
      }
      await record({
        outcome: "accept",
        ...positive,
        ticketId: ticket.ticketId,
        ...(ticket.goalId ? { goalId: ticket.goalId } : {}),
      });
      return;
    }
    // observe: a positive assessment is what Core WOULD have taken on; it takes on nothing.
    await record({
      outcome: "ignore",
      wouldAccept,
      matchedRuleIds: verdict.matchedRuleIds,
      reason: verdict.reason,
    });
  }

  async function notifyUnavailable(decision: Decision): Promise<void> {
    if (!options.onUnavailable) return;
    try {
      const rows = await options.decisions.list();
      const previous = rows.find(
        (row) => row.id !== decision.id && isAssessmentAttempt(row)
      );
      if (previous?.outcome === "unavailable") return;
      await options.onUnavailable({
        id: `eval-unavailable-${decision.id}`,
        decisionId: decision.id,
        thread: decision.thread,
        at: decision.decidedAt,
        unavailableReason: decision.unavailableReason ?? "assessment failed",
        message: unavailableMessage(decision),
      });
    } catch (error) {
      options.onError?.(error);
    }
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

function isAssessmentAttempt(decision: Decision): boolean {
  // Deterministic gates say nothing about whether the model recovered. The hourly limit does.
  return !decision.gate || decision.unavailableReason === "assessment_limit";
}

function unavailableMessage(decision: Decision): string {
  const reason = decision.unavailableReason ?? "assessment failed";
  if (reason === "assessment_limit") {
    return "Automatic event checks reached their hourly limit. They will try again after the hour.";
  }
  if (reason === "unparseable_reply") {
    return "The model did not return a usable assessment, so automatic event checks need attention.";
  }
  const detail = reason.length <= 300 ? reason : `${reason.slice(0, 300)}...`;
  return `Automatic event checks could not reach the model provider: ${detail}`;
}
