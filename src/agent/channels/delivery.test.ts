import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTicketChannelNotifier } from "./delivery.ts";
import type { ChannelAdapter, ChannelSendInput } from "./types.ts";
import { createTicketStore } from "../tickets/store.ts";
import { key } from "../tickets/ids.ts";
import type { Trigger } from "../sources/types.ts";

const channel = {
  source: "external-chat",
  thread: "conversation:42",
  address: { conversationId: "42", room: "room-a" },
};

const trigger: Trigger = {
  id: key("trigger", "external-chat", "message-1"),
  source: "external-chat",
  kind: "message.created",
  at: "2026-11-06T10:00:00.000Z",
  threads: [channel.thread],
  payload: { text: "please check this" },
  actor: { source: "external-chat", id: "person-7" },
  human: true,
  channel,
};

async function acceptedTicket() {
  const tickets = createTicketStore({});
  const ticket = await tickets.recordAccepted({
    evalId: key("eval", "external-chat", "message-1"),
    decisionId: key("decision", "message-1"),
    thread: channel.thread,
    at: trigger.at,
    title: "Check the request",
    requester: trigger.source,
    policyVersion: "policy-1",
    matchedRuleIds: ["rule-1"],
    scope: [],
    triggers: [trigger],
    goalId: "goal-1",
  });
  return { tickets, ticket };
}

describe("Ticket channel notifications", () => {
  it("sends only to a ChannelRef persisted on the matching Ticket with a stable idempotency key", async () => {
    const { tickets, ticket } = await acceptedTicket();
    const sent: ChannelSendInput[] = [];
    const adapter: ChannelAdapter = {
      id: channel.source,
      accepts: () => true,
      send: async (input) => {
        sent.push(input);
      },
    };
    const notifier = createTicketChannelNotifier({
      tickets,
      adapters: [adapter],
    });
    const notice = {
      id: "goal-1:blocked:2026-11-06T10:02:00.000Z",
      goalId: "goal-1",
      type: "goal_needs_person" as const,
      reason: "blocked" as const,
      message: "The task needs your help.",
    };

    expect(
      await notifier.deliver({ ticketId: ticket.id, channel, notice })
    ).toMatchObject({ status: "sent" });
    expect(
      await notifier.deliver({ ticketId: ticket.id, channel, notice })
    ).toMatchObject({ status: "sent" });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
    expect(sent[0]?.notice.ticketId).toBe(ticket.id);

    expect(
      await notifier.deliver({
        ticketId: ticket.id,
        channel: { ...channel, thread: "conversation:other" },
        notice,
      })
    ).toMatchObject({ status: "not_owned" });
    expect(
      await notifier.deliver({
        ticketId: ticket.id,
        channel,
        notice: { ...notice, goalId: "another-goal" },
      })
    ).toMatchObject({ status: "not_owned" });
    expect(sent).toHaveLength(2);
  });

  it("makes a notice durable before attempting delivery", async () => {
    const { tickets, ticket } = await acceptedTicket();
    const outboxDir = await mkdtemp(join(tmpdir(), "thebe-channel-outbox-"));
    const sent: ChannelSendInput[] = [];
    const notifier = createTicketChannelNotifier({
      tickets,
      adapters: [
        {
          id: channel.source,
          accepts: () => true,
          send: async (input) => {
            sent.push(input);
          },
        },
      ],
      outboxDir,
      now: () => new Date("2026-11-06T10:02:00.000Z"),
    });

    await notifier.enqueueNeedsPerson({
      id: "goal-1:blocked:2026-11-06T10:02:00.000Z",
      goalId: "goal-1",
      ticketId: ticket.id,
      reason: "blocked",
      message: "The task needs your help.",
    });
    expect(await notifier.pending()).toHaveLength(1);
    expect(sent).toHaveLength(0);

    await notifier.flush();
    expect(sent).toHaveLength(1);
    expect(await notifier.pending()).toHaveLength(0);
    await notifier.stop();
  });

  it("delivers a completed notice once with a stable idempotency key", async () => {
    const { tickets, ticket } = await acceptedTicket();
    const sent: ChannelSendInput[] = [];
    const notifier = createTicketChannelNotifier({
      tickets,
      adapters: [
        {
          id: channel.source,
          accepts: () => true,
          send: async (input) => {
            sent.push(input);
          },
        },
      ],
    });

    await notifier.enqueueCompleted({
      id: "goal-1:completed:2026-11-06T10:05:00.000Z",
      goalId: "goal-1",
      ticketId: ticket.id,
      message: "A task is complete: the backup set was verified.",
    });
    expect(await notifier.pending()).toHaveLength(1);
    await notifier.flush();
    await notifier.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.notice).toMatchObject({
      type: "goal_completed",
      ticketId: ticket.id,
      message: "A task is complete: the backup set was verified.",
    });
    expect(sent[0]?.idempotencyKey).toMatch(/^[a-f0-9]{32}$/);
    await notifier.stop();
  });

  it("does not modify Ticket state when a channel adapter fails", async () => {
    const { tickets, ticket } = await acceptedTicket();
    const outboxDir = await mkdtemp(join(tmpdir(), "thebe-channel-outbox-"));
    const before = await tickets.get(ticket.id);
    let now = new Date("2026-11-06T10:02:00.000Z");
    const failedAttempts: ChannelSendInput[] = [];
    const adapter: ChannelAdapter = {
      id: channel.source,
      accepts: () => true,
      send: async (input) => {
        failedAttempts.push(input);
        throw new Error("channel unavailable");
      },
    };
    const notifier = createTicketChannelNotifier({
      tickets,
      adapters: [adapter],
      outboxDir,
      now: () => now,
      retryBaseMs: 5,
    });

    await expect(
      notifier.notifyNeedsPerson({
        id: "goal-1:blocked:2026-11-06T10:02:00.000Z",
        goalId: "goal-1",
        ticketId: ticket.id,
        reason: "blocked",
        message: "The task needs your help.",
      })
    ).resolves.toBeUndefined();
    expect(await tickets.get(ticket.id)).toEqual(before);
    expect(await notifier.pending()).toHaveLength(1);
    expect(failedAttempts).toHaveLength(1);

    const delivered: ChannelSendInput[] = [];
    const restarted = createTicketChannelNotifier({
      tickets,
      adapters: [
        {
          id: channel.source,
          accepts: () => true,
          send: async (input) => {
            delivered.push(input);
          },
        },
      ],
      outboxDir,
      now: () => now,
      retryBaseMs: 5,
    });
    now = new Date(now.getTime() + 10);
    await restarted.flush();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.idempotencyKey).toBe(
      failedAttempts[0]?.idempotencyKey
    );
    expect(await restarted.pending()).toEqual([]);
    expect(await tickets.get(ticket.id)).toEqual(before);
    await notifier.stop();
    await restarted.stop();
  });
});
