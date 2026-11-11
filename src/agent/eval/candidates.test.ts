import { describe, expect, it } from "vitest";
import type { Trigger } from "../sources/types.ts";
import { createTriggerStore } from "../sources/store.ts";
import type { TicketTaskView } from "../tickets/control.ts";
import { createTicketStore } from "../tickets/store.ts";
import { createCandidateApi } from "./candidates.ts";
import { createDecisionStore } from "./decision-store.ts";
import { createEvalDispositionStore } from "./disposition-store.ts";
import {
  DECISION_ACCEPT_TOOL_NAME,
  DECISION_ATTACH_TOOL_NAME,
  DECISION_DISMISS_TOOL_NAME,
  DECISION_GET_TOOL_NAME,
  DECISION_LIST_TOOL_NAME,
} from "./tools.ts";
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
  actor: { source: "container-health", id: "person-7" },
  human: true,
  channel: {
    source: "container-health",
    thread: "resource:container:emby",
    address: { destination: "room-42" },
  },
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
  const dispositions = createEvalDispositionStore({});
  const triggers = createTriggerStore({});
  await triggers.add([trigger]);
  const tickets = createTicketStore({});
  const started: unknown[] = [];
  const reopened: string[] = [];
  let stage: TicketTaskView["stage"] = "running";
  let goals = 0;
  let failNextGoalStart = false;
  const api = createCandidateApi({
    decisions,
    dispositions,
    tickets,
    ticketView: async (ticketId): Promise<TicketTaskView | undefined> => {
      const ticket = await tickets.get(ticketId);
      if (!ticket) return undefined;
      return {
        ticket,
        stage,
        pendingPermissions: [],
        receipt: {
          state: stage,
          complete: ["completed", "failed", "cancelled"].includes(stage),
        },
      };
    },
    triggers,
    policy: { get: async () => policy },
    goals: {
      startGoal: async (input) => {
        started.push(input);
        goals += 1;
        if (failNextGoalStart) {
          failNextGoalStart = false;
          stage = "unassigned";
          throw new Error("goal runtime unavailable");
        }
        stage = "running";
        return { thebeSessionId: `goal-${goals}` };
      },
      reopenGoal: async (goalId) => {
        if (
          stage === "completed" ||
          stage === "blocked" ||
          stage === "failed"
        ) {
          reopened.push(goalId);
          stage = "running";
        }
      },
    },
    sessions: {
      createSession: async () => ({ thebeSessionId: `goal-${goals + 1}` }),
    },
    servicesForResource: (kind) => (kind === "container" ? ["docker"] : []),
    now: () => new Date(NOW),
  });
  return {
    api,
    candidate,
    decisions,
    dispositions,
    tickets,
    started,
    reopened,
    setStage: (next: TicketTaskView["stage"]) => {
      stage = next;
    },
    failNextGoalStart: () => {
      failNextGoalStart = true;
    },
  };
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
        origins: [
          {
            triggerId: TRIGGER_ID,
            source: "container-health",
            actor: { source: "container-health", id: "person-7" },
            human: true,
            channel: trigger.channel,
          },
        ],
        channels: [trigger.channel],
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

  it("keeps the Ticket before starting its Goal and retries an unassigned accepted Ticket", async () => {
    const s = await setup();
    s.failNextGoalStart();
    const caller = { writes: true, irreversible: false };

    await expect(
      s.api.invoke(
        DECISION_ACCEPT_TOOL_NAME,
        { decisionId: DECISION_ID },
        caller
      )
    ).rejects.toThrow("goal runtime unavailable");
    const [persisted] = await s.tickets.list();
    expect(persisted?.links.legacyGoalId).toBe("goal-1");
    expect(persisted?.channels).toEqual([trigger.channel]);

    await expect(
      s.api.invoke(
        DECISION_ACCEPT_TOOL_NAME,
        { decisionId: DECISION_ID },
        caller
      )
    ).resolves.toMatchObject({ reused: true, stage: "running" });
    expect(s.started).toHaveLength(2);
    expect(await s.tickets.list()).toHaveLength(1);
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

  it("dismisses a candidate without rewriting the Decision or hiding it from an explicit acceptance", async () => {
    const s = await setup();
    const caller = { writes: true, irreversible: false };

    await expect(
      s.api.invoke(
        DECISION_DISMISS_TOOL_NAME,
        { decisionId: DECISION_ID, reason: "Already handled manually." },
        caller
      )
    ).resolves.toMatchObject({
      reused: false,
      decision: {
        id: DECISION_ID,
        candidate: true,
        dismissed: true,
        dismissalReason: "Already handled manually.",
      },
    });
    await expect(s.decisions.get(DECISION_ID)).resolves.toEqual(s.candidate);
    await expect(
      s.api.invoke(DECISION_LIST_TOOL_NAME, { candidateOnly: true }, caller)
    ).resolves.toEqual({ decisions: [] });
    await expect(
      s.api.invoke(DECISION_GET_TOOL_NAME, { decisionId: DECISION_ID }, caller)
    ).resolves.toMatchObject({
      candidate: true,
      dismissed: true,
    });
    await expect(
      s.api.invoke(
        DECISION_DISMISS_TOOL_NAME,
        { decisionId: DECISION_ID },
        caller
      )
    ).resolves.toMatchObject({
      reused: true,
      decision: { dismissed: true },
    });

    await expect(
      s.api.invoke(
        DECISION_ACCEPT_TOOL_NAME,
        { decisionId: DECISION_ID },
        caller
      )
    ).resolves.toMatchObject({
      decisionId: DECISION_ID,
      candidate: false,
      reused: false,
    });
    expect(s.started).toHaveLength(1);
  });

  it("attaches the Decision idempotently to an explicitly named live Ticket without another Eval", async () => {
    const s = await setup();
    const target = await s.tickets.recordDirect({
      thread: "chat:target",
      triggerId: "4".repeat(32),
      kind: "goal-start",
      at: "2026-11-10T09:00:00.000Z",
      title: "Existing media task",
      requester: "chat",
      goalId: "goal-target",
    });
    const caller = { writes: true, irreversible: false };
    const attached = await s.api.invoke(
      DECISION_ATTACH_TOOL_NAME,
      {
        decisionId: DECISION_ID,
        ticketId: target.id,
        note: "Use this failure as context for the cleanup.",
      },
      caller
    );
    expect(attached).toMatchObject({
      decisionId: DECISION_ID,
      attachedTicketId: target.id,
      reused: false,
      stage: "running",
      ticket: {
        subscriptions: ["chat:target", "resource:container:emby"],
        inputs: [
          {
            triggerId: TRIGGER_ID,
            note: "Use this failure as context for the cleanup.",
          },
        ],
      },
    });
    expect(s.started).toEqual([]);
    expect(s.reopened).toEqual([]);
    await expect(
      s.api.invoke(DECISION_GET_TOOL_NAME, { decisionId: DECISION_ID }, caller)
    ).resolves.toMatchObject({
      candidate: false,
      attachedTicketId: target.id,
    });
    await expect(
      s.api.invoke(DECISION_LIST_TOOL_NAME, { candidateOnly: true }, caller)
    ).resolves.toEqual({ decisions: [] });

    await expect(
      s.api.invoke(
        DECISION_ATTACH_TOOL_NAME,
        { decisionId: DECISION_ID, ticketId: target.id },
        caller
      )
    ).resolves.toMatchObject({
      attachedTicketId: target.id,
      reused: true,
    });
    expect((await s.tickets.get(target.id))?.inputs).toHaveLength(1);
    await expect(
      s.api.invoke(
        DECISION_ACCEPT_TOOL_NAME,
        { decisionId: DECISION_ID },
        caller
      )
    ).rejects.toMatchObject({ status: 409, code: "already_attached" });
    expect(s.started).toEqual([]);
  });

  it("reopens ended work under the same Ticket and refuses one a person stopped", async () => {
    const reopened = await setup();
    const ended = await reopened.tickets.recordDirect({
      thread: "chat:ended",
      triggerId: "5".repeat(32),
      kind: "goal-start",
      at: "2026-11-10T09:00:00.000Z",
      title: "Finished media task",
      requester: "chat",
      goalId: "goal-ended",
    });
    reopened.setStage("completed");
    await expect(
      reopened.api.invoke(
        DECISION_ATTACH_TOOL_NAME,
        { decisionId: DECISION_ID, ticketId: ended.id },
        { writes: true, irreversible: false }
      )
    ).resolves.toMatchObject({
      attachedTicketId: ended.id,
      ticket: {
        id: ended.id,
        mandate: ended.mandate,
        links: { legacyGoalId: "goal-ended" },
      },
    });
    expect(reopened.reopened).toEqual(["goal-ended"]);
    expect(reopened.started).toEqual([]);

    const stopped = await setup();
    const stoppedTicket = await stopped.tickets.recordDirect({
      thread: "chat:stopped",
      triggerId: "6".repeat(32),
      kind: "goal-start",
      at: "2026-11-10T09:00:00.000Z",
      title: "Stopped media task",
      requester: "chat",
      goalId: "goal-stopped",
    });
    stopped.setStage("cancelled");
    await expect(
      stopped.api.invoke(
        DECISION_ATTACH_TOOL_NAME,
        { decisionId: DECISION_ID, ticketId: stoppedTicket.id },
        { writes: true, irreversible: false }
      )
    ).rejects.toMatchObject({ status: 409, code: "ticket_stopped" });
    expect((await stopped.tickets.get(stoppedTicket.id))?.inputs).toEqual([]);
    expect(stopped.reopened).toEqual([]);
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
    await expect(
      noWrite.api.invoke(
        DECISION_ATTACH_TOOL_NAME,
        { decisionId: DECISION_ID, ticketId: "4".repeat(32) },
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
