import type {
  GoalCompletedNotice,
  GoalNeedsPersonNotice,
} from "../goals/service.ts";
import { key } from "../tickets/ids.ts";
import type { TicketStore } from "../tickets/store.ts";
import type { ChannelRef } from "../sources/types.ts";
import type { ChannelAdapter, TicketChannelNotice } from "./types.ts";
import {
  createChannelOutbox,
  type ChannelDeliveryAttempt,
  type QueuedChannelNotice,
} from "./outbox.ts";

/** Distributes over the notice union so each variant keeps its own fields. */
type NoticeWithoutTicket = TicketChannelNotice extends infer Notice
  ? Notice extends TicketChannelNotice
    ? Omit<Notice, "ticketId">
    : never
  : never;

export type ChannelDeliveryResult =
  | { status: "sent"; channel: ChannelRef }
  | { status: "not_owned"; channel: ChannelRef }
  | { status: "adapter_missing"; channel: ChannelRef }
  | { status: "address_rejected"; channel: ChannelRef }
  | { status: "failed"; channel: ChannelRef };

/** Sends Goal attention notices only to destinations already recorded on their Ticket. */
export function createTicketChannelNotifier(options: {
  tickets: Pick<TicketStore, "get">;
  adapters: readonly ChannelAdapter[];
  outboxDir?: string;
  now?: () => Date;
  retryBaseMs?: number;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  const adapterIds = options.adapters.map((adapter) => adapter.id);
  if (adapterIds.some((id) => !id.trim())) {
    throw new Error("Channel adapter ids must not be empty");
  }
  if (new Set(adapterIds).size !== adapterIds.length) {
    throw new Error("Channel adapter ids must be unique");
  }
  const adapters = new Map(
    options.adapters.map((adapter) => [adapter.id, adapter])
  );
  const outbox = createChannelOutbox({
    dir: options.outboxDir,
    now: options.now,
    retryBaseMs: options.retryBaseMs,
    pollIntervalMs: options.pollIntervalMs,
    send: async (entry) => {
      const { ticketId, ...notice } = entry.notice;
      const result = await deliver({
        ticketId,
        channel: entry.channel,
        notice,
      });
      return deliveryAttempt(result);
    },
    onError: options.onError,
  });

  async function deliver(input: {
    ticketId: string;
    channel: ChannelRef;
    notice: NoticeWithoutTicket;
  }): Promise<ChannelDeliveryResult> {
    const ticket = await options.tickets
      .get(input.ticketId)
      .catch(() => undefined);
    if (
      !ticket ||
      ticket.links.legacyGoalId !== input.notice.goalId ||
      !isChannelRef(input.channel) ||
      !(ticket.channels ?? []).some(
        (saved) => isChannelRef(saved) && sameChannelRef(saved, input.channel)
      )
    ) {
      return { status: "not_owned", channel: input.channel };
    }
    const adapter = adapters.get(input.channel.source);
    if (!adapter) return { status: "adapter_missing", channel: input.channel };

    const destination = cloneChannelRef(input.channel);
    const notice: TicketChannelNotice = {
      ...input.notice,
      ticketId: ticket.id,
    };
    const idempotencyKey = ticketChannelNoticeKey(
      ticket.id,
      notice.id,
      notice.goalId,
      destination
    );
    try {
      if (!(await adapter.accepts(cloneChannelRef(destination)))) {
        return { status: "address_rejected", channel: input.channel };
      }
      await adapter.send({
        channel: cloneChannelRef(destination),
        notice,
        idempotencyKey,
      });
      return { status: "sent", channel: input.channel };
    } catch {
      // Delivery is supplementary. A broken adapter must never alter Goal or Ticket state.
      return { status: "failed", channel: input.channel };
    }
  }

  /** Makes a notice durable. Delivery stays a separate, retryable step. */
  async function enqueueForTicket(input: {
    ticketId: string;
    goalId: string;
    notice: NoticeWithoutTicket;
  }): Promise<void> {
    const ticket = await options.tickets
      .get(input.ticketId)
      .catch(() => undefined);
    if (!ticket || ticket.links.legacyGoalId !== input.goalId) return;
    const queued: QueuedChannelNotice[] = (ticket.channels ?? [])
      .filter(isChannelRef)
      .map((channel) => ({
        id: ticketChannelNoticeKey(
          ticket.id,
          input.notice.id,
          input.notice.goalId,
          channel
        ),
        channel: cloneChannelRef(channel),
        notice: { ...input.notice, ticketId: ticket.id },
      }));
    await outbox.enqueue(queued);
  }

  async function enqueueNeedsPerson(
    notice: GoalNeedsPersonNotice
  ): Promise<void> {
    if (!notice.ticketId) return;
    await enqueueForTicket({
      ticketId: notice.ticketId,
      goalId: notice.goalId,
      notice: {
        id: notice.id,
        goalId: notice.goalId,
        type: "goal_needs_person",
        reason: notice.reason,
        message: notice.message,
      },
    });
  }

  async function enqueueCompleted(
    notice: GoalCompletedNotice
  ): Promise<void> {
    if (!notice.ticketId) return;
    await enqueueForTicket({
      ticketId: notice.ticketId,
      goalId: notice.goalId,
      notice: {
        id: notice.id,
        goalId: notice.goalId,
        type: "goal_completed",
        message: notice.message,
      },
    });
  }

  async function notifyNeedsPerson(
    notice: GoalNeedsPersonNotice
  ): Promise<void> {
    await enqueueNeedsPerson(notice);
    await outbox.flush();
  }

  return {
    deliver,
    enqueueNeedsPerson,
    enqueueCompleted,
    notifyNeedsPerson,
    start: outbox.start,
    stop: outbox.stop,
    flush: outbox.flush,
    pending: outbox.pending,
  };
}

function ticketChannelNoticeKey(
  ticketId: string,
  noticeId: string,
  goalId: string,
  channel: ChannelRef
): string {
  return key(
    "ticket-channel-notice",
    ticketId,
    noticeId,
    goalId,
    ...channelKeyParts(channel)
  );
}

function deliveryAttempt(
  result: ChannelDeliveryResult
): ChannelDeliveryAttempt {
  if (result.status === "sent") return { status: "sent" };
  if (result.status === "not_owned" || result.status === "address_rejected") {
    return { status: "discard" };
  }
  return { status: "retry", error: result.status };
}

function sameChannelRef(left: ChannelRef, right: ChannelRef): boolean {
  return (
    JSON.stringify(channelKeyParts(left)) ===
    JSON.stringify(channelKeyParts(right))
  );
}

function isChannelRef(value: unknown): value is ChannelRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const channel = value as Partial<ChannelRef>;
  if (
    typeof channel.source !== "string" ||
    !channel.source.trim() ||
    typeof channel.thread !== "string" ||
    !channel.thread.trim()
  ) {
    return false;
  }
  if (channel.address === undefined) return true;
  return (
    Boolean(channel.address) &&
    typeof channel.address === "object" &&
    !Array.isArray(channel.address) &&
    Object.values(channel.address).every((entry) => typeof entry === "string")
  );
}

function channelKeyParts(channel: ChannelRef): string[] {
  const address = Object.entries(channel.address ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => [key, value]);
  return [channel.source, channel.thread, ...address];
}

function cloneChannelRef(channel: ChannelRef): ChannelRef {
  return {
    source: channel.source,
    thread: channel.thread,
    ...(channel.address ? { address: { ...channel.address } } : {}),
  };
}
