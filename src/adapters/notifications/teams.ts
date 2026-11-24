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
  truncate,
} from "./shared.ts";

const MAX_TEXT = 20_000;

/** Microsoft Teams incoming webhook, using the MessageCard shape the connector still accepts. */
export function createTeamsNotificationAdapter(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "teams",
    capabilities: { proactive: true, markdown: true, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return webhookUrl(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const url = webhookUrl(input.target.channel.address);
      if (!url) return { status: "discard", reason: "teams_url_missing" };
      const result = await postJson(
        send,
        url,
        {
          "@type": "MessageCard",
          "@context": "https://schema.org/extensions",
          themeColor:
            input.notification.priority === "critical" ? "D13438" : "0078D4",
          summary: truncate(input.notification.title, 250),
          sections: [
            {
              activityTitle: truncate(input.notification.title, 250),
              text: truncate(
                [
                  input.notification.body,
                  ...(input.notification.deepLink
                    ? [`[Open](${input.notification.deepLink})`]
                    : []),
                ].join("\n\n"),
                MAX_TEXT
              ),
              markdown: true,
            },
          ],
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

function webhookUrl(
  address: Record<string, string> | undefined
): string | undefined {
  return httpUrl(addressValue(address, "url"));
}
