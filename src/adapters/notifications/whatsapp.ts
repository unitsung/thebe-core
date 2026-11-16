import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import {
  addressValue,
  classifyHttp,
  postJson,
  responseDetail,
  truncate,
} from "./shared.ts";

const MAX_TEXT = 4_096;

/**
 * WhatsApp Cloud API. The Meta access token and phone-number id are host configuration; a target names
 * the recipient. Outside the 24-hour customer-service window Meta refuses free-form text, which is a
 * permanent refusal here rather than an endless retry.
 */
export function createWhatsAppNotificationAdapter(options: {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  const version = options.apiVersion?.trim() || "v20.0";
  return {
    id: "whatsapp",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return recipient(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const to = recipient(input.target.channel.address);
      if (!to) return { status: "discard", reason: "whatsapp_to_missing" };
      const result = await postJson(
        send,
        `https://graph.facebook.com/${version}/${encodeURIComponent(
          options.phoneNumberId
        )}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: {
            preview_url: false,
            body: truncate(
              [
                input.notification.title,
                input.notification.body,
                ...(input.notification.deepLink
                  ? [input.notification.deepLink]
                  : []),
              ].join("\n\n"),
              MAX_TEXT
            ),
          },
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: {
            authorization: `Bearer ${options.accessToken}`,
            "idempotency-key": input.idempotencyKey,
          },
        }
      );
      return classifyHttp(result, {
        detail: responseDetail(
          result.kind === "response" ? result.body : undefined,
          result.kind === "response" ? result.text : ""
        ),
      });
    },
  };
}

function recipient(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "to");
  if (!raw || !/^\+?\d{7,20}$/.test(raw)) return undefined;
  return raw.replace(/^\+/, "");
}
