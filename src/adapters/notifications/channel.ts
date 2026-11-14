import type {
  ChannelAdapter,
  TicketChannelNotice,
} from "../../agent/channels/types.ts";
import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";

/**
 * Adapts an existing Source channel (Feishu, GitHub, ...) to the notification router. Ticket notices keep
 * their exact write-back shape; any other notice becomes a plain message so an owner target can use the same
 * channel without a second delivery stack.
 */
export function createChannelNotificationAdapter(
  adapter: ChannelAdapter
): NotificationAdapter {
  return {
    id: adapter.id,
    capabilities: { proactive: true, markdown: false },
    accepts(channel: ChannelRef): boolean | Promise<boolean> {
      return adapter.accepts(channel);
    },
    async send(input: NotificationSendInput) {
      try {
        await adapter.send({
          channel: input.target.channel,
          notice: channelNotice(input.notification),
          idempotencyKey: input.idempotencyKey,
        });
        return { status: "sent" };
      } catch (error) {
        return {
          status: "retry",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function channelNotice(
  notification: NotificationSendInput["notification"]
): TicketChannelNotice {
  const ticketScoped = Boolean(notification.ticketId && notification.goalId);
  const message = ticketScoped
    ? notification.body
    : `${notification.title}\n\n${notification.body}`;
  if (notification.category === "completed") {
    return {
      id: notification.id,
      ticketId: notification.ticketId ?? notification.id,
      goalId: notification.goalId ?? notification.id,
      type: "goal_completed",
      message,
    };
  }
  return {
    id: notification.id,
    ticketId: notification.ticketId ?? notification.id,
    goalId: notification.goalId ?? notification.id,
    type: "goal_needs_person",
    reason: notification.ticketReason ?? "blocked",
    message,
  };
}
