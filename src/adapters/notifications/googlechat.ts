import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import {
  addressValue,
  classifyHttp,
  httpUrl,
  postJson,
  renderNotice,
  truncate,
} from "./shared.ts";

const MAX_TEXT = 4_000;

/** Google Chat incoming webhook. Plain text keeps the notice readable in every client. */
export function createGoogleChatNotificationAdapter(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "googlechat",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return webhookUrl(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const url = webhookUrl(input.target.channel.address);
      if (!url) return { status: "discard", reason: "googlechat_url_missing" };
      const result = await postJson(
        send,
        url,
        { text: truncate(renderNotice(input, { separator: "\n" }), MAX_TEXT) },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: { "idempotency-key": input.idempotencyKey },
        }
      );
      return classifyHttp(result);
    },
  };
}

function webhookUrl(
  address: Record<string, string> | undefined
): string | undefined {
  return httpUrl(addressValue(address, "url"));
}
