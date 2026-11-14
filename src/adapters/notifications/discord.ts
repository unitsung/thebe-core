import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import { addressValue, classifyHttp, postJson, truncate } from "./shared.ts";

const MAX_TEXT = 2_000;

/** Discord webhook. `allowed_mentions` is empty so a notice can never ping a role or user. */
export function createDiscordNotificationAdapter(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "discord",
    capabilities: { proactive: true, markdown: true, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return webhookUrl(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const url = webhookUrl(input.target.channel.address);
      if (!url) return { status: "discard", reason: "discord_url_missing" };
      const result = await postJson(
        send,
        url,
        {
          content: truncate(render(input), MAX_TEXT - 20),
          allowed_mentions: { parse: [] },
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
  const lines = [`**${input.notification.title}**`, input.notification.body];
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
