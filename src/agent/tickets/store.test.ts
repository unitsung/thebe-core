import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { key } from "./ids.ts";
import { createTicketStore, MAX_INPUTS_PER_TICKET } from "./store.ts";

const request = (n: number) => ({
  thread: `chat:s${n}`,
  triggerId: key("trigger", "chat", `s${n}`),
  kind: "goal-start",
  at: `2026-11-06T10:00:0${n}.000Z`,
  title: `task ${n}`,
  requester: "chat",
  goalId: `s${n}`,
  sessionIds: [`s${n}`],
});

const trigger = (n: number, thread = "resource:container:emby") => ({
  id: key("trigger", "container-health", String(n)),
  source: "container-health",
  kind: "container.went_down",
  at: `2026-11-06T10:05:0${n}.000Z`,
  threads: [thread],
  payload: { from: "running", to: "exited" },
});

describe("key", () => {
  it("is stable, 32 hex characters, and does not confuse where the parts split", () => {
    expect(key("a", "bc")).toBe(key("a", "bc"));
    expect(key("a", "bc")).toMatch(/^[a-f0-9]{32}$/);
    expect(key("a", "bc")).not.toBe(key("ab", "c"));
    expect(key("a")).not.toBe(key("a", ""));
  });
});

describe("ticket store", () => {
  it("gives the same Ticket for the same request, so a retry does not make a second", async () => {
    const store = createTicketStore({});
    const first = await store.recordDirect(request(1));
    const again = await store.recordDirect(request(1));
    expect(again.id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
    expect(first.mandate).toMatchObject({
      strength: "explicit",
      decidedBy: "direct",
    });
    expect(first.id).toMatch(/^[a-f0-9]{32}$/);
  });

  it("finds a Ticket by its Goal and lists newest first", async () => {
    const store = createTicketStore({});
    const a = await store.recordDirect(request(1));
    const b = await store.recordDirect(request(2));
    expect((await store.getByGoal("s2"))?.id).toBe(b.id);
    expect((await store.list()).map((t) => t.id)).toEqual([b.id, a.id]);
    expect(await store.getByGoal("nope")).toBeUndefined();
    expect(await store.get("../etc/passwd")).toBeUndefined();
  });

  it("survives a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tickets-"));
    const first = await createTicketStore({ dir }).recordDirect(request(3));
    const reopened = createTicketStore({ dir });
    expect(await reopened.get(first.id)).toEqual(first);
    expect(await reopened.recordDirect(request(3))).toEqual(first);
    expect(await reopened.list()).toHaveLength(1);
  });

  it("gives concurrent startup reads the fully loaded store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tickets-"));
    const first = await createTicketStore({ dir }).recordDirect(request(4));
    const reopened = createTicketStore({ dir });
    // Recovery lists at startup while a caller can already delegate; the later read must wait for
    // the same load rather than seeing an empty in-memory map.
    const [listed, found] = await Promise.all([
      reopened.list(),
      reopened.get(first.id),
    ]);
    expect(found).toEqual(first);
    expect(listed.map((ticket) => ticket.id)).toEqual([first.id]);
  });

  it("keeps only the newest tickets within its bound", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tickets-"));
    const store = createTicketStore({ dir, maxItems: 2 });
    await store.recordDirect(request(1));
    await store.recordDirect(request(2));
    await store.recordDirect(request(3));
    expect((await store.list()).map((t) => t.title)).toEqual([
      "task 3",
      "task 2",
    ]);
    expect(await createTicketStore({ dir }).list()).toHaveLength(2);
  });
});

describe("a Ticket for work Eval took on", () => {
  const accepted = {
    evalId: key("eval", "resource:container:emby", "v", "t"),
    decisionId: key("decision", "e"),
    thread: "resource:container:emby",
    at: "2026-11-06T10:00:00.000Z",
    title: "Restart emby",
    requester: "container-health",
    policyVersion: "v1",
    matchedRuleIds: ["r1"],
    scope: ["container_restart:emby"],
  };

  it("is inferred and by Eval, and its Mandate names the policy, the rules and what it may touch", async () => {
    const store = createTicketStore({});
    const ticket = await store.recordAccepted(accepted);
    expect(ticket.mandate).toEqual({
      strength: "inferred",
      decidedBy: "eval",
      evalId: accepted.evalId,
      requester: "container-health",
      policyVersion: "v1",
      matchedRuleIds: ["r1"],
      scope: ["container_restart:emby"],
    });
    expect(ticket.links).toEqual({
      decisionId: accepted.decisionId,
      sessionIds: [],
    });
    expect(ticket.subscriptions).toEqual(["resource:container:emby"]);
  });

  it("persists source identity and reply channels without adding authority to the Mandate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tickets-origin-"));
    const origin = {
      ...trigger(1),
      actor: { source: "container-health", id: "person-7" },
      human: false,
      channel: {
        source: "container-health",
        thread: "resource:container:emby",
        address: { destination: "room-42" },
      },
    };
    const ticket = await createTicketStore({ dir }).recordAccepted({
      ...accepted,
      triggers: [origin],
    });
    const loaded = await createTicketStore({ dir }).get(ticket.id);

    expect(loaded?.origins).toEqual([
      {
        triggerId: origin.id,
        source: "container-health",
        kind: "container.went_down",
        actor: { source: "container-health", id: "person-7" },
        human: false,
        channel: origin.channel,
      },
    ]);
    expect(loaded?.channels).toEqual([origin.channel]);
    expect(loaded?.mandate).toEqual(ticket.mandate);
    expect(loaded?.mandate.scope).toEqual(["container_restart:emby"]);
  });

  it("is the same Ticket when the same Eval is taken on again, and survives a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tickets-"));
    const first = await createTicketStore({ dir }).recordAccepted(accepted);
    const again = await createTicketStore({ dir }).recordAccepted({
      ...accepted,
      title: "a different title",
    });
    expect(again.id).toBe(first.id);
    // The first record stands.
    expect(again.title).toBe(first.title);
    expect(await createTicketStore({ dir }).list()).toHaveLength(1);
  });
});

describe("a Ticket for a person-accepted Decision", () => {
  it("is explicit, links the unchanged Decision, and is found by either id", async () => {
    const store = createTicketStore({});
    const input = {
      evalId: key("eval", "candidate"),
      decisionId: key("decision", "candidate"),
      thread: "resource:container:emby",
      at: "2026-11-10T10:00:00.000Z",
      title: "Restart emby",
      requester: "chat",
      goalId: "goal-candidate",
    };
    const ticket = await store.recordDecisionAccepted(input);
    expect(ticket).toMatchObject({
      title: "Restart emby",
      mandate: {
        strength: "explicit",
        decidedBy: "direct",
        evalId: input.evalId,
        requester: "chat",
      },
      subscriptions: [input.thread],
      links: {
        decisionId: input.decisionId,
        legacyGoalId: input.goalId,
        sessionIds: [input.goalId],
      },
    });
    expect((await store.getByDecision(input.decisionId))?.id).toBe(ticket.id);
    expect((await store.getByGoal(input.goalId))?.id).toBe(ticket.id);
    expect(await store.recordDecisionAccepted(input)).toEqual(ticket);
  });
});

describe("ticket fan-out and inputs", () => {
  it("attaches a trigger to an active subscribed ticket", async () => {
    const store = createTicketStore({});
    const ticket = await store.recordDirect({
      ...request(1),
      subscriptions: ["resource:container:emby"],
    });
    const event = {
      ...trigger(1),
      actor: { source: "container-health", id: "bot-2" },
      human: false,
      channel: {
        source: "container-health",
        thread: "resource:container:emby",
        address: { destination: "room-42" },
      },
    };
    const attached = await store.attachTrigger({
      trigger: event,
      isLive: () => true,
    });
    expect(attached).toEqual([ticket.id]);
    const updated = await store.get(ticket.id);
    expect(updated?.inputs).toHaveLength(1);
    expect(updated?.inputs[0]).toMatchObject({
      triggerId: event.id,
      seq: 1,
      source: "container-health",
      kind: "container.went_down",
      thread: "resource:container:emby",
      actor: { source: "container-health", id: "bot-2" },
      human: false,
      channel: event.channel,
    });
    expect(updated?.channels).toEqual([event.channel]);
  });

  it("ignores ended tickets and attaches nothing when no live ticket is subscribed", async () => {
    const store = createTicketStore({});
    await store.recordDirect({
      ...request(1),
      subscriptions: ["resource:container:emby"],
    });
    const attached = await store.attachTrigger({
      trigger: trigger(1),
      isLive: () => false,
    });
    expect(attached).toEqual([]);
  });

  it("gives the event to the newest live ticket when multiple match", async () => {
    const store = createTicketStore({});
    const first = await store.recordDirect({
      ...request(1),
      subscriptions: ["resource:container:emby"],
    });
    const second = await store.recordDirect({
      ...request(2),
      subscriptions: ["resource:container:emby"],
    });
    const attached = await store.attachTrigger({
      trigger: trigger(1),
      isLive: () => true,
    });
    expect(attached).toEqual([second.id]);
    expect((await store.get(first.id))?.inputs).toHaveLength(0);
    expect((await store.get(second.id))?.inputs).toHaveLength(1);
  });

  it("is idempotent when the same trigger is attached twice", async () => {
    const store = createTicketStore({});
    const ticket = await store.recordDirect({
      ...request(1),
      subscriptions: ["resource:container:emby"],
    });
    const first = await store.attachTrigger({
      trigger: trigger(1),
      isLive: () => true,
    });
    const second = await store.attachTrigger({
      trigger: trigger(1),
      isLive: () => true,
    });
    expect(first).toEqual([ticket.id]);
    expect(second).toEqual([ticket.id]);
    expect((await store.get(ticket.id))?.inputs).toHaveLength(1);
  });

  it("attaches explicitly to one Ticket with its Thread subscription and routing note", async () => {
    const store = createTicketStore({});
    const ticket = await store.recordDirect(request(1));
    const first = await store.attachToTicket({
      ticketId: ticket.id,
      triggers: [trigger(1)],
      note: "This belongs to the media cleanup.",
      attachedAt: "2026-11-10T11:00:00.000Z",
    });
    expect(first).toMatchObject({
      reused: false,
      addedTriggerIds: [trigger(1).id],
      ticket: {
        subscriptions: ["chat:s1", "resource:container:emby"],
        inputs: [
          {
            triggerId: trigger(1).id,
            seq: 1,
            note: "This belongs to the media cleanup.",
            attachedAt: "2026-11-10T11:00:00.000Z",
          },
        ],
      },
    });

    const again = await store.attachToTicket({
      ticketId: ticket.id,
      triggers: [trigger(1)],
      note: "A retry must not duplicate the event.",
    });
    expect(again).toMatchObject({
      reused: true,
      addedTriggerIds: [],
    });
    expect((await store.get(ticket.id))?.inputs).toHaveLength(1);
  });

  it("returns no attachment for an unknown explicit Ticket", async () => {
    const store = createTicketStore({});
    await expect(
      store.attachToTicket({
        ticketId: "f".repeat(32),
        triggers: [trigger(1)],
      })
    ).resolves.toBeUndefined();
  });

  it("persists inputs across a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tickets-inputs-"));
    const firstStore = createTicketStore({ dir });
    const ticket = await firstStore.recordDirect({
      ...request(1),
      subscriptions: ["resource:container:emby"],
    });
    const event = {
      ...trigger(1),
      actor: { source: "container-health", id: "person-7" },
      human: true,
      channel: {
        source: "container-health",
        thread: "resource:container:emby",
        address: { destination: "room-42" },
      },
    };
    await firstStore.attachTrigger({
      trigger: event,
      isLive: () => true,
    });
    const secondStore = createTicketStore({ dir });
    const loaded = await secondStore.get(ticket.id);
    expect(loaded?.inputs).toHaveLength(1);
    expect(loaded?.inputs[0]).toMatchObject({
      triggerId: event.id,
      actor: { source: "container-health", id: "person-7" },
      human: true,
      channel: event.channel,
    });
    expect(loaded?.channels).toEqual([event.channel]);
  });

  it("keeps input sequence monotonic after pruning the oldest event", async () => {
    const store = createTicketStore({});
    const ticket = await store.recordDirect({
      ...request(1),
      subscriptions: ["resource:container:emby"],
    });
    for (let index = 1; index <= MAX_INPUTS_PER_TICKET + 1; index += 1) {
      await store.attachTrigger({
        trigger: trigger(index),
        isLive: () => true,
      });
    }
    const inputs = (await store.get(ticket.id))?.inputs ?? [];
    expect(inputs).toHaveLength(MAX_INPUTS_PER_TICKET);
    expect(inputs[0]?.seq).toBe(2);
    expect(inputs.at(-1)?.seq).toBe(MAX_INPUTS_PER_TICKET + 1);
  });
});
