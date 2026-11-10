import type { McpCaller } from "../interface.ts";
import type { TriggerStore } from "../sources/store.ts";
import type { Trigger } from "../sources/types.ts";
import type { TicketTaskView } from "../tickets/control.ts";
import { inferScope } from "../tickets/mandate.ts";
import type { TicketStore } from "../tickets/store.ts";
import type { Ticket } from "../tickets/types.ts";
import { httpError } from "../types.ts";
import type { DecisionStore } from "./decision-store.ts";
import { executorTask } from "./executor-task.ts";
import {
  DECISION_ACCEPT_TOOL_NAME,
  DECISION_GET_TOOL_NAME,
  DECISION_LIST_TOOL_NAME,
  type DecisionToolName,
} from "./tools.ts";
import type { Decision, Policy, PolicyRule } from "./types.ts";

const DEFAULT_DECISION_LIST_LIMIT = 20;
const MAX_DECISION_LIST_LIMIT = 50;

const EXECUTOR_GOAL = "Handle the event that matched the person's rules.";
const EXECUTOR_CRITERION =
  "The situation the event describes is resolved, checked with the read tools after any action; or you reported why it cannot be (blocked), or that nothing needed doing (dropped).";

export type CandidateView = Decision & {
  /** Positive and not yet accepted by any Ticket. A manual acceptance stops it being a candidate. */
  candidate: boolean;
  /** Present when this Decision is linked to a Ticket, including one accepted by a person. */
  acceptedTicketId?: string;
};

export type AcceptedCandidate = TicketTaskView & {
  decisionId: string;
  candidate: false;
  reused: boolean;
};

type GoalPort = {
  startGoal(input: {
    thebeSessionId: string;
    goal: string;
    criteria?: string[];
    executor?: "ticket";
  }): Promise<unknown>;
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
  tickets: Pick<
    TicketStore,
    "list" | "get" | "getByDecision" | "recordDecisionAccepted"
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

  function candidateView(decision: Decision, ticket?: Ticket): CandidateView {
    const acceptedTicketId = ticket?.id ?? decision.ticketId;
    return {
      ...decision,
      candidate:
        decision.wouldAccept === true &&
        decision.outcome !== "accept" &&
        !acceptedTicketId,
      ...(acceptedTicketId ? { acceptedTicketId } : {}),
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
    const [decisions, tickets] = await Promise.all([
      options.decisions.list(thread ? { thread } : undefined),
      options.tickets.list(),
    ]);
    const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
    const ticketsByDecision = new Map(
      tickets.flatMap((ticket) =>
        ticket.links.decisionId
          ? [[ticket.links.decisionId, ticket] as const]
          : []
      )
    );
    const rows = decisions.map((decision) =>
      candidateView(
        decision,
        (decision.ticketId ? ticketsById.get(decision.ticketId) : undefined) ??
          ticketsByDecision.get(decision.id)
      )
    );
    return rows
      .filter((decision) => input.candidateOnly !== true || decision.candidate)
      .slice(0, limit);
  }

  async function get(decisionId: string): Promise<CandidateView | undefined> {
    const decision = await options.decisions.get(decisionId);
    if (!decision) return undefined;
    return candidateView(decision, await existingTicket(decision));
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
        const ticket = await options.ticketView(existing.id);
        if (!ticket) {
          throw httpError(
            409,
            "the Ticket for this Decision is missing",
            "ticket_missing"
          );
        }
        return {
          ...ticket,
          decisionId: decision.id,
          candidate: false as const,
          reused: true,
        };
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
      await options.goals.startGoal({
        thebeSessionId: session.thebeSessionId,
        goal: executorTask({
          intent: EXECUTOR_GOAL,
          rules,
          triggers,
          scope,
        }),
        criteria: [EXECUTOR_CRITERION],
        executor: "ticket",
      });
      const ticket = await options.tickets.recordDecisionAccepted({
        evalId: decision.evalId,
        decisionId: decision.id,
        thread: decision.thread,
        at: options.now().toISOString(),
        title: title.slice(0, 120),
        requester: "chat",
        goalId: session.thebeSessionId,
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
    }
  }

  return {
    invoke,
    list,
    get,
    accept,
  };
}
