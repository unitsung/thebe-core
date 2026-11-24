import type { McpCaller } from "../interface.ts";
import type { TriggerStore } from "../sources/store.ts";
import type { Trigger } from "../sources/types.ts";
import type { TicketTaskView } from "../tickets/control.ts";
import { inferScope } from "../tickets/mandate.ts";
import type { TicketStore } from "../tickets/store.ts";
import { MAX_TICKET_NOTE_CHARS } from "../tickets/tools.ts";
import type { Ticket } from "../tickets/types.ts";
import { httpError } from "../types.ts";
import type { DecisionStore } from "./decision-store.ts";
import type {
  DecisionDismissal,
  EvalDispositionStore,
} from "./disposition-store.ts";
import { executorTask } from "./executor-task.ts";
import {
  DECISION_ACCEPT_TOOL_NAME,
  DECISION_ATTACH_TOOL_NAME,
  DECISION_DISMISS_TOOL_NAME,
  DECISION_GET_TOOL_NAME,
  DECISION_LIST_TOOL_NAME,
  type DecisionToolName,
} from "./tools.ts";
import type { Decision, Policy, PolicyRule } from "./types.ts";

const DEFAULT_DECISION_LIST_LIMIT = 20;
const MAX_DECISION_LIST_LIMIT = 50;
const MAX_DISMISSAL_REASON_CHARS = 500;

const EXECUTOR_GOAL = "Handle the event that matched the person's rules.";
const EXECUTOR_CRITERION =
  "The situation the event describes is resolved, checked with the read tools after any action; or you reported why it cannot be (blocked), or that nothing needed doing (dropped).";

export type CandidateView = Decision & {
  /** Positive and not yet accepted by any Ticket. A manual acceptance stops it being a candidate. */
  candidate: boolean;
  /** Present when this Decision is linked to a Ticket, including one accepted by a person. */
  acceptedTicketId?: string;
  /** Present when at least one of this Decision's Triggers was explicitly attached to a Ticket. */
  attachedTicketId?: string;
  /** A person has hidden this candidate without changing the Decision itself. */
  dismissed: boolean;
  dismissedAt?: string;
  dismissalReason?: string;
};

export type AcceptedCandidate = TicketTaskView & {
  decisionId: string;
  candidate: false;
  reused: boolean;
};

export type AttachedCandidate = TicketTaskView & {
  decisionId: string;
  attachedTicketId: string;
  reused: boolean;
};

type GoalPort = {
  startGoal(input: {
    thebeSessionId: string;
    goal: string;
    criteria?: string[];
    executor?: "ticket";
  }): Promise<unknown>;
  /** Reopens one terminal Ticket Goal for a fresh checkpoint after a person attached an event. */
  reopenGoal?(thebeSessionId: string): Promise<unknown>;
};

type SessionPort = {
  createSession(input: {
    title?: string;
    labels?: Record<string, string>;
  }): Promise<{ thebeSessionId: string }>;
};

export type CandidateApi = ReturnType<typeof createCandidateApi>;

export function createCandidateApi(options: {
  decisions: Pick<DecisionStore, "get" | "list">;
  dispositions: Pick<
    EvalDispositionStore,
    "dismissDecision" | "getDecisionDismissal" | "listDecisionDismissals"
  >;
  tickets: Pick<
    TicketStore,
    | "list"
    | "get"
    | "getByDecision"
    | "recordDecisionAccepted"
    | "attachToTicket"
  >;
  ticketView: (ticketId: string) => Promise<TicketTaskView | undefined>;
  triggers: Pick<TriggerStore, "list">;
  policy: { get(): Promise<Policy> };
  goals: GoalPort;
  sessions: SessionPort;
  servicesForResource: (kind: string) => readonly string[];
  now: () => Date;
}) {
  const acceptFlights = new Map<string, Promise<AcceptedCandidate>>();
  const attachFlights = new Map<string, Promise<AttachedCandidate>>();
  const dismissFlights = new Map<
    string,
    Promise<{ decision: CandidateView; reused: boolean }>
  >();

  function candidateView(
    decision: Decision,
    ticket?: Ticket,
    attachedTicketId?: string,
    dismissal?: DecisionDismissal
  ): CandidateView {
    const acceptedTicketId = ticket?.id ?? decision.ticketId;
    return {
      ...decision,
      candidate:
        decision.wouldAccept === true &&
        decision.outcome !== "unavailable" &&
        decision.outcome !== "accept" &&
        !acceptedTicketId &&
        !attachedTicketId,
      ...(acceptedTicketId ? { acceptedTicketId } : {}),
      ...(attachedTicketId ? { attachedTicketId } : {}),
      dismissed: Boolean(dismissal),
      ...(dismissal
        ? {
            dismissedAt: dismissal.at,
            ...(dismissal.reason ? { dismissalReason: dismissal.reason } : {}),
          }
        : {}),
    };
  }

  async function existingTicket(
    decision: Decision
  ): Promise<Ticket | undefined> {
    if (decision.ticketId) {
      const byId = await options.tickets.get(decision.ticketId);
      if (byId) return byId;
    }
    return options.tickets.getByDecision(decision.id);
  }

  function latestAttachments(
    tickets: readonly Ticket[]
  ): Map<string, { ticketId: string; attachedAt: string }> {
    const attachments = new Map<
      string,
      { ticketId: string; attachedAt: string }
    >();
    for (const ticket of tickets) {
      for (const input of ticket.inputs) {
        const current = attachments.get(input.triggerId);
        if (!current || current.attachedAt < input.attachedAt) {
          attachments.set(input.triggerId, {
            ticketId: ticket.id,
            attachedAt: input.attachedAt,
          });
        }
      }
    }
    return attachments;
  }

  function attachmentFor(
    decision: Decision,
    attachments: ReadonlyMap<string, { ticketId: string; attachedAt: string }>
  ): { ticketId: string; attachedAt: string } | undefined {
    return decision.triggerIds
      .flatMap((id) => {
        const attachment = attachments.get(id);
        return attachment ? [attachment] : [];
      })
      .sort((left, right) =>
        right.attachedAt.localeCompare(left.attachedAt)
      )[0];
  }

  async function project(
    decisions: readonly Decision[]
  ): Promise<CandidateView[]> {
    const [tickets, dismissals] = await Promise.all([
      options.tickets.list(),
      options.dispositions.listDecisionDismissals(),
    ]);
    const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
    const dismissalsByDecision = new Map(
      dismissals.map((dismissal) => [dismissal.decisionId, dismissal])
    );
    const ticketsByDecision = new Map(
      tickets.flatMap((ticket) =>
        ticket.links.decisionId
          ? [[ticket.links.decisionId, ticket] as const]
          : []
      )
    );
    const attachments = latestAttachments(tickets);
    return decisions.map((decision) => {
      const attached = attachmentFor(decision, attachments);
      return candidateView(
        decision,
        (decision.ticketId ? ticketsById.get(decision.ticketId) : undefined) ??
          ticketsByDecision.get(decision.id),
        attached?.ticketId,
        dismissalsByDecision.get(decision.id)
      );
    });
  }

  async function list(
    input: Record<string, unknown>
  ): Promise<CandidateView[]> {
    const requested =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.floor(input.limit)
        : DEFAULT_DECISION_LIST_LIMIT;
    const limit = Math.max(1, Math.min(MAX_DECISION_LIST_LIMIT, requested));
    const thread =
      typeof input.thread === "string" && input.thread.trim()
        ? input.thread.trim()
        : undefined;
    if (
      input.candidateOnly !== undefined &&
      typeof input.candidateOnly !== "boolean"
    ) {
      throw httpError(400, "candidateOnly must be a boolean", "invalid_body");
    }
    const decisions = await options.decisions.list(
      thread ? { thread } : undefined
    );
    const rows = await project(decisions);
    return rows
      .filter(
        (decision) =>
          input.candidateOnly !== true ||
          (decision.candidate && !decision.dismissed)
      )
      .slice(0, limit);
  }

  async function get(decisionId: string): Promise<CandidateView | undefined> {
    const decision = await options.decisions.get(decisionId);
    if (!decision) return undefined;
    const [tickets, dismissal] = await Promise.all([
      options.tickets.list(),
      options.dispositions.getDecisionDismissal(decisionId),
    ]);
    return candidateView(
      decision,
      await existingTicket(decision),
      attachmentFor(decision, latestAttachments(tickets))?.ticketId,
      dismissal
    );
  }

  async function dismiss(
    decisionId: string,
    reason?: string
  ): Promise<{ decision: CandidateView; reused: boolean }> {
    const pending = dismissFlights.get(decisionId);
    if (pending) return pending;
    const flight = (async () => {
      const before = await get(decisionId);
      if (!before) {
        throw httpError(404, "decision not found", "not_found");
      }
      if (!before.candidate) {
        throw httpError(
          409,
          "only a positive candidate without a Ticket can be dismissed",
          "not_candidate"
        );
      }
      if (before.dismissed) {
        return { decision: before, reused: true };
      }
      const dismissal = await options.dispositions.dismissDecision({
        decisionId,
        at: options.now().toISOString(),
        ...(reason ? { reason } : {}),
      });
      return {
        decision: {
          ...before,
          dismissed: true,
          dismissedAt: dismissal.at,
          ...(dismissal.reason ? { dismissalReason: dismissal.reason } : {}),
        },
        reused: false,
      };
    })();
    dismissFlights.set(decisionId, flight);
    try {
      return await flight;
    } finally {
      dismissFlights.delete(decisionId);
    }
  }

  async function triggersFor(decision: Decision): Promise<Trigger[]> {
    const rows = await options.triggers.list({ thread: decision.thread });
    const byId = new Map(rows.map((trigger) => [trigger.id, trigger]));
    const triggers = decision.triggerIds
      .map((id) => byId.get(id))
      .filter((trigger): trigger is Trigger => Boolean(trigger));
    if (triggers.length !== decision.triggerIds.length) {
      throw httpError(
        409,
        "the source events for this candidate are no longer available",
        "candidate_triggers_missing"
      );
    }
    return triggers;
  }

  async function startAcceptedGoal(input: {
    goalId: string;
    triggers: readonly Trigger[];
    rules: readonly PolicyRule[];
    scope: readonly string[];
  }): Promise<void> {
    await options.goals.startGoal({
      thebeSessionId: input.goalId,
      goal: executorTask({
        intent: EXECUTOR_GOAL,
        rules: input.rules,
        triggers: input.triggers,
        scope: input.scope,
      }),
      criteria: [EXECUTOR_CRITERION],
      executor: "ticket",
    });
  }

  async function rulesFor(decision: Decision): Promise<PolicyRule[]> {
    const current = await options.policy.get();
    const byId = new Map(
      [...current.rules, ...(decision.matchedRules ?? [])].map((rule) => [
        rule.id,
        rule,
      ])
    );
    const rules = decision.matchedRuleIds
      .map((id) => byId.get(id))
      .filter((rule): rule is PolicyRule => Boolean(rule));
    if (
      decision.matchedRuleIds.length === 0 ||
      rules.length !== decision.matchedRuleIds.length
    ) {
      throw httpError(
        409,
        "the Policy rules behind this candidate are no longer available",
        "candidate_rules_missing"
      );
    }
    return rules;
  }

  async function accept(decisionId: string): Promise<AcceptedCandidate> {
    const pending = acceptFlights.get(decisionId);
    if (pending) return pending;
    const flight = (async () => {
      const decision = await options.decisions.get(decisionId);
      if (!decision) {
        throw httpError(404, "decision not found", "not_found");
      }
      const existing = await existingTicket(decision);
      if (existing) {
        let ticket = await options.ticketView(existing.id);
        if (!ticket) {
          throw httpError(
            409,
            "the Ticket for this Decision is missing",
            "ticket_missing"
          );
        }
        if (
          ticket.stage === "unassigned" &&
          existing.links.legacyGoalId &&
          existing.links.decisionId === decision.id
        ) {
          const [triggers, rules] = await Promise.all([
            triggersFor(decision),
            rulesFor(decision),
          ]);
          await startAcceptedGoal({
            goalId: existing.links.legacyGoalId,
            triggers,
            rules,
            scope:
              existing.mandate.scope ??
              inferScope(triggers, options.servicesForResource),
          });
          const resumed = await options.ticketView(existing.id);
          if (!resumed) {
            throw httpError(
              409,
              "the Ticket for this Decision is missing",
              "ticket_missing"
            );
          }
          ticket = resumed;
        }
        return {
          ...ticket,
          decisionId: decision.id,
          candidate: false as const,
          reused: true,
        };
      }
      const attached = attachmentFor(
        decision,
        latestAttachments(await options.tickets.list())
      );
      if (attached) {
        throw httpError(
          409,
          "this Decision was attached to a Ticket; attach it to another Ticket or leave it as context",
          "already_attached"
        );
      }
      if (decision.outcome === "accept") {
        throw httpError(
          409,
          "the Ticket for this accepted Decision is missing",
          "ticket_missing"
        );
      }
      if (decision.wouldAccept !== true) {
        throw httpError(
          409,
          "this Decision is not a positive candidate",
          "not_candidate"
        );
      }
      const [triggers, rules] = await Promise.all([
        triggersFor(decision),
        rulesFor(decision),
      ]);
      const scope = inferScope(triggers, options.servicesForResource);
      const title =
        decision.intent?.trim() ||
        decision.reason.trim() ||
        `Review ${decision.thread}`;
      const session = await options.sessions.createSession({
        title: title.slice(0, 80),
        labels: {
          kind: "goal",
          mainSessionDecisionId: decision.id,
        },
      });
      const ticket = await options.tickets.recordDecisionAccepted({
        evalId: decision.evalId,
        decisionId: decision.id,
        thread: decision.thread,
        at: options.now().toISOString(),
        title: title.slice(0, 120),
        requester: "chat",
        goalId: session.thebeSessionId,
        triggers,
      });
      await startAcceptedGoal({
        goalId: session.thebeSessionId,
        triggers,
        rules,
        scope,
      });
      const view = await options.ticketView(ticket.id);
      if (!view) {
        throw httpError(
          500,
          "the accepted Ticket could not be read",
          "ticket_missing"
        );
      }
      return {
        ...view,
        decisionId: decision.id,
        candidate: false as const,
        reused: false,
      };
    })();
    acceptFlights.set(decisionId, flight);
    try {
      return await flight;
    } finally {
      acceptFlights.delete(decisionId);
    }
  }

  async function attach(input: {
    decisionId: string;
    ticketId: string;
    note?: string;
  }): Promise<AttachedCandidate> {
    const decisionId = input.decisionId.trim();
    const ticketId = input.ticketId.trim();
    if (!decisionId) {
      throw httpError(400, "decisionId is required", "invalid_body");
    }
    if (!ticketId) {
      throw httpError(400, "ticketId is required", "invalid_body");
    }
    const note = input.note?.trim();
    if (note && note.length > MAX_TICKET_NOTE_CHARS) {
      throw httpError(
        400,
        `note is longer than ${MAX_TICKET_NOTE_CHARS} characters`,
        "invalid_body"
      );
    }
    const flightKey = `${decisionId}\0${ticketId}`;
    const pending = attachFlights.get(flightKey);
    if (pending) return pending;
    const flight = (async () => {
      const decision = await options.decisions.get(decisionId);
      if (!decision) {
        throw httpError(404, "decision not found", "not_found");
      }
      const ticket = await options.tickets.get(ticketId);
      if (!ticket) {
        throw httpError(404, "ticket not found", "not_found");
      }
      const before = await options.ticketView(ticket.id);
      if (!before) {
        throw httpError(404, "ticket not found", "not_found");
      }
      if (before.stage === "unassigned") {
        throw httpError(
          409,
          "this Ticket has no Goal to carry out the attached event",
          "ticket_unassigned"
        );
      }
      if (before.stage === "cancelled") {
        throw httpError(
          409,
          "a person stopped this Ticket; attach the event to another Ticket or accept it as new work",
          "ticket_stopped"
        );
      }
      if (!ticket.links.legacyGoalId || !options.goals.reopenGoal) {
        throw httpError(
          409,
          "this Ticket has no Goal to carry out the attached event",
          "ticket_unassigned"
        );
      }
      if (decision.outcome === "accept" || (await existingTicket(decision))) {
        throw httpError(
          409,
          "this Decision already became a Ticket; attach the event to another Ticket",
          "already_accepted"
        );
      }
      const triggers = await triggersFor(decision);
      const attached = await options.tickets.attachToTicket({
        ticketId: ticket.id,
        triggers,
        ...(note ? { note } : {}),
        attachedAt: options.now().toISOString(),
      });
      if (!attached) {
        throw httpError(404, "ticket not found", "not_found");
      }
      // Reopening is also the retry path when an Input was written but Core stopped before its
      // terminal Goal resumed. A live or paused Goal treats this call as a no-op.
      await options.goals.reopenGoal(ticket.links.legacyGoalId);
      const view = await options.ticketView(ticket.id);
      if (!view) {
        throw httpError(500, "the Ticket could not be read", "ticket_missing");
      }
      return {
        ...view,
        decisionId: decision.id,
        attachedTicketId: ticket.id,
        reused: attached.reused,
      };
    })();
    attachFlights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      attachFlights.delete(flightKey);
    }
  }

  async function invoke(
    name: DecisionToolName,
    input: Record<string, unknown>,
    caller: McpCaller
  ): Promise<unknown> {
    switch (name) {
      case DECISION_LIST_TOOL_NAME:
        return { decisions: await list(input) };
      case DECISION_GET_TOOL_NAME: {
        const decisionId =
          typeof input.decisionId === "string" ? input.decisionId.trim() : "";
        if (!decisionId) {
          throw httpError(400, "decisionId is required", "invalid_body");
        }
        const decision = await get(decisionId);
        if (!decision) {
          throw httpError(404, "decision not found", "not_found");
        }
        return decision;
      }
      case DECISION_ACCEPT_TOOL_NAME: {
        if (!caller.writes) {
          throw httpError(
            403,
            "accepting a candidate needs write permission",
            "mcp_write_required"
          );
        }
        const decisionId =
          typeof input.decisionId === "string" ? input.decisionId.trim() : "";
        if (!decisionId) {
          throw httpError(400, "decisionId is required", "invalid_body");
        }
        return accept(decisionId);
      }
      case DECISION_ATTACH_TOOL_NAME: {
        if (!caller.writes) {
          throw httpError(
            403,
            "attaching a Decision needs write permission",
            "mcp_write_required"
          );
        }
        const decisionId =
          typeof input.decisionId === "string" ? input.decisionId.trim() : "";
        const ticketId =
          typeof input.ticketId === "string" ? input.ticketId.trim() : "";
        if (!decisionId) {
          throw httpError(400, "decisionId is required", "invalid_body");
        }
        if (!ticketId) {
          throw httpError(400, "ticketId is required", "invalid_body");
        }
        return attach({
          decisionId,
          ticketId,
          ...(typeof input.note === "string" ? { note: input.note } : {}),
        });
      }
      case DECISION_DISMISS_TOOL_NAME: {
        if (!caller.writes) {
          throw httpError(
            403,
            "dismissing a candidate needs write permission",
            "mcp_write_required"
          );
        }
        const decisionId =
          typeof input.decisionId === "string" ? input.decisionId.trim() : "";
        if (!decisionId) {
          throw httpError(400, "decisionId is required", "invalid_body");
        }
        const reason =
          typeof input.reason === "string" ? input.reason.trim() : "";
        if (reason.length > MAX_DISMISSAL_REASON_CHARS) {
          throw httpError(
            400,
            `reason is longer than ${MAX_DISMISSAL_REASON_CHARS} characters`,
            "invalid_body"
          );
        }
        return dismiss(decisionId, reason || undefined);
      }
    }
  }

  return {
    invoke,
    list,
    get,
    accept,
    attach,
    dismiss,
    project,
  };
}
