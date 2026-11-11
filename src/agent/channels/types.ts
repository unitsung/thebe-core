import type { ChannelRef } from "../sources/types.ts";

export type TicketChannelNotice = {
  id: string;
  ticketId: string;
  goalId: string;
  type: "goal_needs_person";
  reason: "answer" | "review" | "blocked" | "stalled";
  message: string;
};

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
