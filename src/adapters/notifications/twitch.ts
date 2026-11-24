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

const MAX_TEXT = 500;

/**
 * Twitch Helix Send Chat Message. A user access token with `user:write:chat` sends as that user; the
 * client id, token, and sender id are host configuration, while a target names the broadcaster whose
 * chat receives the notice. Twitch has no server-side idempotency key, so a retry can duplicate a
 * message that the platform already accepted.
 */
export function createTwitchNotificationAdapter(options: {
  clientId: string;
  userAccessToken: string;
  senderId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "twitch",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return broadcasterId(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const broadcaster = broadcasterId(input.target.channel.address);
      if (!broadcaster) {
        return { status: "discard", reason: "twitch_broadcaster_missing" };
      }
      const result = await postJson(
        send,
        "https://api.twitch.tv/helix/chat/messages",
        {
          broadcaster_id: broadcaster,
          sender_id: options.senderId,
          message: truncate(
            renderNotice(input).replace(/[\r\n]+/g, " "),
            MAX_TEXT
          ),
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: {
            authorization: `Bearer ${options.userAccessToken}`,
            "client-id": options.clientId,
            "idempotency-key": input.idempotencyKey,
          },
        }
      );
      const attempt = classifyHttp(result);
      if (result.kind !== "response" || !result.body) return attempt;
      const body = result.body as Record<string, unknown>;
      if (!Array.isArray(body.data)) return attempt;
      const first =
        body.data[0] && typeof body.data[0] === "object"
          ? (body.data[0] as Record<string, unknown>)
          : undefined;
      if (!first) {
        return { status: "discard", reason: "twitch_no_message_receipt" };
      }
      if (first.is_sent === false) {
        return { status: "discard", reason: "twitch_message_not_sent" };
      }
      return attempt;
    },
  };
}

function broadcasterId(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "broadcasterId");
  return raw && /^\d{1,20}$/.test(raw) ? raw : undefined;
}
