import { describe, expect, it } from "vitest";
import type {
  ChannelAdapter,
  ChannelSendInput,
} from "../../agent/channels/types.ts";
import type { NotificationSendInput } from "../../agent/notifications/types.ts";
import { createChannelNotificationAdapter } from "./channel.ts";

function input(
  notification: NotificationSendInput["notification"]
): NotificationSendInput {
  return {
    target: {
      id: "ticket:abc",
      channel: { source: "feishu", thread: "oc_chat" },
      categories: "all",
      enabled: true,
    },
    notification,
    idempotencyKey: "idem-1",
  };
}

describe("Source channel notification adapter", () => {
  it("maps an attention notice and keeps the idempotency key", async () => {
    const sent: ChannelSendInput[] = [];
    const channel: ChannelAdapter = {
      id: "feishu",
      accepts: () => true,
      send: async (value) => {
        sent.push(value);
      },
    };
    const adapter = createChannelNotificationAdapter(channel);
    expect(adapter.accepts({ source: "feishu", thread: "oc_chat" })).toBe(true);
    const result = await adapter.send(
      input({
        id: "goal-1:blocked",
        category: "attention",
        priority: "critical",
        title: "Thebe",
        body: "The backup drive is offline.",
        ticketId: "ticket-1",
        goalId: "goal-1",
        ticketReason: "blocked",
        createdAt: "2026-11-14T10:00:00.000Z",
      })
    );
    expect(result).toEqual({ status: "sent" });
    expect(sent[0]).toMatchObject({
      idempotencyKey: "idem-1",
      notice: {
        id: "goal-1:blocked",
        ticketId: "ticket-1",
        goalId: "goal-1",
        type: "goal_needs_person",
        reason: "blocked",
        message: "The backup drive is offline.",
      },
    });
  });

  it("maps a completion notice and sends a non-Ticket notice as a plain message", async () => {
    const sent: ChannelSendInput[] = [];
    const adapter = createChannelNotificationAdapter({
      id: "feishu",
      accepts: () => true,
      send: async (value) => {
        sent.push(value);
      },
    });
    const completed = await adapter.send(
      input({
        id: "goal-1:completed",
        category: "completed",
        priority: "normal",
        title: "Thebe",
        body: "The backup set was verified.",
        ticketId: "ticket-1",
        goalId: "goal-1",
        createdAt: "2026-11-14T10:00:00.000Z",
      })
    );
    expect(completed).toEqual({ status: "sent" });
    expect(sent[0]?.notice.type).toBe("goal_completed");

    const other = await adapter.send(
      input({
        id: "budget-1",
        category: "budget",
        priority: "normal",
        title: "Thebe",
        body: "Budget warning.",
        createdAt: "2026-11-14T10:00:00.000Z",
      })
    );
    expect(other).toEqual({ status: "sent" });
    expect(sent[1]?.notice).toMatchObject({
      type: "goal_needs_person",
      ticketId: "budget-1",
      goalId: "budget-1",
      message: "Thebe\n\nBudget warning.",
    });
  });

  it("turns an adapter failure into a retry", async () => {
    const adapter = createChannelNotificationAdapter({
      id: "feishu",
      accepts: () => true,
      send: async () => {
        throw new Error("connection reset");
      },
    });
    expect(
      await adapter.send(
        input({
          id: "goal-1:blocked",
          category: "attention",
          priority: "critical",
          title: "Thebe",
          body: "The backup drive is offline.",
          ticketId: "ticket-1",
          goalId: "goal-1",
          createdAt: "2026-11-14T10:00:00.000Z",
        })
      )
    ).toMatchObject({ status: "retry", reason: "connection reset" });
  });
});
