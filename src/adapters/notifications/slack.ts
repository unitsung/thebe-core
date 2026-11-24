import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import { addressValue, classifyHttp, postJson, truncate } from "./shared.ts";

const MAX_TEXT = 39_000;

/** Slack Incoming Webhook. The address owns the secret; only HTTP(S) endpoints are accepted. */
export function createSlackNotificationAdapter(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "slack",
    capabilities: { proactive: true, markdown: true, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return webhookUrl(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const url = webhookUrl(input.target.channel.address);
      if (!url) return { status: "discard", reason: "slack_url_missing" };
      const result = await postJson(
        send,
        url,
        {
          text: truncate(render(input), MAX_TEXT),
          mrkdwn: true,
          unfurl_links: false,
          unfurl_media: false,
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

function render(input: NotificationSendInput): string {
  const lines = [`*${input.notification.title}*`, input.notification.body];
  if (input.notification.deepLink) lines.push(input.notification.deepLink);
  return lines.join("\n\n");
}

function webhookUrl(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "url");
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
