import { createHash } from "node:crypto";
import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import {
  addressValue,
  classifyHttp,
  postJson,
  renderNotice,
  truncate,
} from "./shared.ts";

const MAX_TEXT = 5_000;

/**
 * LINE Messaging API push message. The channel access token is host configuration; a target names a
 * user, group, or room id. LINE accepts a retry key with a push, so a retried outbox entry keeps the
 * same deterministic UUID and does not create a second message within LINE's retry window.
 */
export function createLineNotificationAdapter(options: {
  channelAccessToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "line",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return recipient(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const to = recipient(input.target.channel.address);
      if (!to) return { status: "discard", reason: "line_to_missing" };
      const result = await postJson(
        send,
        "https://api.line.me/v2/bot/message/push",
        {
          to,
          messages: [
            {
              type: "text",
              text: truncate(renderNotice(input), MAX_TEXT),
            },
          ],
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: {
            authorization: `Bearer ${options.channelAccessToken}`,
            "x-line-retry-key": retryKey(input.idempotencyKey),
            "idempotency-key": input.idempotencyKey,
          },
        }
      );
      return classifyHttp(result);
    },
  };
}

/** LINE wants a UUID; derive a stable v5-shaped one from the outbox key. */
function retryKey(idempotencyKey: string): string {
  const hash = createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .split("");
  hash[12] = "5";
  hash[16] = "8";
  const value = hash.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join("-");
}

function recipient(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "to");
  if (!raw || raw.length > 128 || /\s/.test(raw)) return undefined;
  return raw;
}
