import { describe, expect, it } from "vitest";
import type { Trigger } from "../sources/types.ts";
import { createTriggerStore } from "../sources/store.ts";
import type { TicketTaskView } from "../tickets/control.ts";
import { createTicketStore } from "../tickets/store.ts";
import { createCandidateApi } from "./candidates.ts";
import { createDecisionStore } from "./decision-store.ts";
import { DECISION_ACCEPT_TOOL_NAME, DECISION_LIST_TOOL_NAME } from "./tools.ts";
import type { Decision, Policy } from "./types.ts";

const NOW = "2026-11-10T10:00:00.000Z";
const TRIGGER_ID = "1".repeat(32);
const DECISION_ID = "2".repeat(32);
const EVAL_ID = "3".repeat(32);

const trigger: Trigger = {
  id: TRIGGER_ID,
  source: "container-health",
  kind: "container.went_down",
  at: "2026-11-10T09:59:00.000Z",
  threads: ["resource:container:emby"],
  resource: { kind: "container", id: "emby" },
  payload: { from: "running", to: "exited" },
};

const policy: Policy = {
  rules: [],
  acceptMode: "observe",
  revision: 0,
  updatedAt: NOW,
};

function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: DECISION_ID,
    evalId: EVAL_ID,
    thread: "resource:container:emby",
    triggerIds: [TRIGGER_ID],
    at: trigger.at,
    outcome: "ignore",
    wouldAccept: true,
    matchedRuleIds: ["restart-media"],
    matchedRules: [
      { id: "restart-media", text: "Restart a media server that stopped." },
    ],
    intent: "Restart the stopped emby container.",
    reason: "The media server stopped.",
    policyVersion: "policy-1",
    decidedAt: "2026-11-10T09:59:01.000Z",
    ...over,
  };
}

async function setup(candidate = decision()) {
  const decisions = createDecisionStore({});
  await decisions.add(candidate);
  const triggers = createTriggerStore({});
  await triggers.add([trigger]);
  const tickets = createTicketStore({});
  const started: unknown[] = [];
  let goals = 0;
  const api = createCandidateApi({
    decisions,
    tickets,
    ticketView: async (ticketId): Promise<TicketTaskView | undefined> => {
      const ticket = await tickets.get(ticketId);
      if (!ticket) return undefined;
      return {
        ticket,
        stage: "running",
        pendingPermissions: [],
        receipt: { state: "running", complete: false },
      };
    },
    triggers,
    policy: { get: async () => policy },
    goals: {
      startGoal: async (input) => {
        started.push(input);
        goals += 1;
        return { thebeSessionId: `goal-${goals}` };
      },
    },
    sessions: {
      createSession: async () => ({ thebeSessionId: `goal-${goals + 1}` }),
    },
    servicesForResource: (kind) => (kind === "container" ? ["docker"] : []),
    now: () => new Date(NOW),
  });
  return { api, candidate, decisions, tickets, started };
}

describe("Decision candidates", () => {
  it("lists positive candidates and accepts one once as an explicit Ticket", async () => {
    const s = await setup();
    const caller = { writes: true, irreversible: false };

    await expect(
      s.api.invoke(DECISION_LIST_TOOL_NAME, { candidateOnly: true }, caller)
    ).resolves.toMatchObject({
      decisions: [
        {
          id: DECISION_ID,
          candidate: true,
          intent: "Restart the stopped emby container.",
        },
      ],
    });

    const accepted = await s.api.invoke(
      DECISION_ACCEPT_TOOL_NAME,
      { decisionId: DECISION_ID },
      caller
    );
    expect(accepted).toMatchObject({
      decisionId: DECISION_ID,
      candidate: false,
      reused: false,
      ticket: {
        mandate: {
          strength: "explicit",
          decidedBy: "direct",
          requester: "chat",
          evalId: EVAL_ID,
        },
        links: {
          decisionId: DECISION_ID,
          legacyGoalId: "goal-1",
        },
      },
    });
    expect(s.started).toHaveLength(1);
    expect(s.started[0]).toMatchObject({
      thebeSessionId: "goal-1",
      executor: "ticket",
    });
    expect(String((s.started[0] as { goal?: unknown }).goal)).toContain(
      "Restart a media server that stopped."
    );
    expect(String((s.started[0] as { goal?: unknown }).goal)).toContain(
      '<tool_output tool="source_events">'
    );

    const again = await s.api.invoke(
      DECISION_ACCEPT_TOOL_NAME,
      { decisionId: DECISION_ID },
      caller
    );
    expect(again).toMatchObject({
      decisionId: DECISION_ID,
      reused: true,
    });
    expect(s.started).toHaveLength(1);
    await expect(s.decisions.get(DECISION_ID)).resolves.toEqual(s.candidate);
    await expect(
      s.api.invoke(DECISION_LIST_TOOL_NAME, { candidateOnly: true }, caller)
    ).resolves.toEqual({ decisions: [] });
  });

  it("refuses a Decision that is not a positive candidate", async () => {
    const s = await setup(
      decision({
        outcome: "ignore",
        wouldAccept: false,
        matchedRuleIds: [],
        matchedRules: [],
      })
    );

    await expect(
      s.api.invoke(
        DECISION_ACCEPT_TOOL_NAME,
        { decisionId: DECISION_ID },
        { writes: true, irreversible: false }
      )
    ).rejects.toMatchObject({ status: 409, code: "not_candidate" });
    expect(s.started).toEqual([]);
  });

  it("requires write permission and reports when source evidence is gone", async () => {
    const noWrite = await setup();
    await expect(
      noWrite.api.invoke(
        DECISION_ACCEPT_TOOL_NAME,
        { decisionId: DECISION_ID },
        { writes: false, irreversible: false }
      )
    ).rejects.toMatchObject({ status: 403, code: "mcp_write_required" });

    const missing = await setup(decision({ triggerIds: ["f".repeat(32)] }));
    await expect(
      missing.api.invoke(
        DECISION_ACCEPT_TOOL_NAME,
        { decisionId: DECISION_ID },
        { writes: true, irreversible: false }
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "candidate_triggers_missing",
    });

    const missingRule = await setup(
      decision({
        matchedRuleIds: ["removed-rule"],
        matchedRules: [],
      })
    );
    await expect(
      missingRule.api.invoke(
        DECISION_ACCEPT_TOOL_NAME,
        { decisionId: DECISION_ID },
        { writes: true, irreversible: false }
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "candidate_rules_missing",
    });
  });
});
