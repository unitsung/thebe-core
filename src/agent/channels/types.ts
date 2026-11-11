import type { ChannelRef } from "../sources/types.ts";

type TicketChannelNoticeBase = {
  id: string;
  ticketId: string;
  goalId: string;
  message: string;
};

export type TicketChannelNotice =
  | (TicketChannelNoticeBase & {
      type: "goal_needs_person";
      reason: "answer" | "review" | "blocked" | "stalled";
    })
  | (TicketChannelNoticeBase & {
      type: "goal_completed";
    });

export type ChannelSendInput = {
  channel: ChannelRef;
  notice: TicketChannelNotice;
  /** Stable for retries of the same notice to the same Ticket destination. */
  idempotencyKey: string;
};

/** A host supplied, vendor-neutral adapter for one Source's write-only reply addresses. */
export type ChannelAdapter = {
  /** Must match `ChannelRef.source`. */
  id: string;
  /** Confirms this adapter is able to deliver to the specific address. */
  accepts(channel: ChannelRef): boolean | Promise<boolean>;
  /** Treats repeated `idempotencyKey` values as the same logical notice. */
  send(input: ChannelSendInput): Promise<void>;
};
