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

const MAX_TEXT = 16_000;

/**
 * Mattermost incoming webhook. The webhook URL is the credential, so it lives in the target address;
 * the settings store is owner-only and masks URL query secrets when read. Mentions are disabled so a
 * notice body cannot page an entire channel.
 */
export function createMattermostNotificationAdapter(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "mattermost",
    capabilities: { proactive: true, markdown: true, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return webhook(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const url = webhook(input.target.channel.address);
      if (!url) {
        return { status: "discard", reason: "mattermost_url_missing" };
      }
      const channel = addressValue(input.target.channel.address, "channel");
      const result = await postJson(
        send,
        url,
        {
          text: truncate(renderNotice(input), MAX_TEXT),
          ...(channel ? { channel } : {}),
          props: { disable_mentions: true },
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: { "idempotency-key": input.idempotencyKey },
        }
      );
      return classifyHttp(result);
    },
  };
}

function webhook(
  address: Record<string, string> | undefined
): string | undefined {
  return httpUrl(addressValue(address, "url"));
}
