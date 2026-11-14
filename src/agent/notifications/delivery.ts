import type { ChannelRef } from "../sources/types.ts";
import type {
  Notification,
  NotificationAdapter,
  NotificationDeliveryAttempt,
  NotificationTarget,
} from "./types.ts";

/**
 * One adapter call with the shared failure rules: an adapter that throws is retryable, a channel it does
 * not accept is permanent, and a missing adapter never pretends the notice was sent.
 */
export async function deliverToAdapters(
  adapters: ReadonlyMap<string, NotificationAdapter>,
  input: {
    target: NotificationTarget;
    notification: Notification;
    idempotencyKey: string;
  }
): Promise<NotificationDeliveryAttempt> {
  const adapter = adapters.get(input.target.channel.source);
  if (!adapter) {
    return {
      status: "discard",
      reason: `adapter_missing:${input.target.channel.source}`,
    };
  }
  try {
    if (!(await adapter.accepts(cloneChannel(input.target.channel)))) {
      return { status: "discard", reason: "address_rejected" };
    }
    return await adapter.send({
      target: input.target,
      notification: input.notification,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    return {
      status: "retry",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function cloneChannel(channel: ChannelRef): ChannelRef {
  return {
    source: channel.source,
    thread: channel.thread,
    ...(channel.address ? { address: { ...channel.address } } : {}),
  };
}
