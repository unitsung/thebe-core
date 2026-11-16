import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import {
  addressValue,
  classifyHttp,
  httpUrl,
  postForm,
  renderNotice,
  truncate,
} from "./shared.ts";

const MAX_TEXT = 2_000;

/**
 * Synology Chat incoming webhook. The endpoint expects a form field named `payload` whose value is
 * JSON, rather than a JSON request body. A 200 response can still contain `{"success": false}`, so
 * the adapter checks the platform-level result instead of trusting the HTTP status alone.
 */
export function createSynologyChatNotificationAdapter(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "synology-chat",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return webhook(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const url = webhook(input.target.channel.address);
      if (!url) {
        return { status: "discard", reason: "synology_chat_url_missing" };
      }
      const form = new URLSearchParams({
        payload: JSON.stringify({
          text: truncate(renderNotice(input), MAX_TEXT),
        }),
      });
      const result = await postForm(send, url, form, {
        timeoutMs: options.timeoutMs ?? 10_000,
        headers: { "idempotency-key": input.idempotencyKey },
      });
      const attempt = classifyHttp(result);
      if (
        attempt.status === "sent" &&
        result.kind === "response" &&
        result.body &&
        typeof result.body === "object" &&
        (result.body as Record<string, unknown>).success === false
      ) {
        return { status: "discard", reason: "synology_chat_refused" };
      }
      return attempt;
    },
  };
}

function webhook(
  address: Record<string, string> | undefined
): string | undefined {
  return httpUrl(addressValue(address, "url"));
}
