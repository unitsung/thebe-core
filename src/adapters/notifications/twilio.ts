import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import {
  addressValue,
  classifyHttp,
  postForm,
  renderNotice,
  truncate,
} from "./shared.ts";

const MAX_TEXT = 1_600;

/** One SMS message through Twilio. Account credentials and the sender stay in host configuration. */
export function createTwilioNotificationAdapter(options: {
  accountSid: string;
  authToken: string;
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(
    `${options.accountSid}:${options.authToken}`,
    "utf8"
  ).toString("base64")}`;
  return {
    id: "twilio",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return recipient(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const to = recipient(input.target.channel.address);
      if (!to) return { status: "discard", reason: "sms_to_missing" };
      const form = new URLSearchParams({
        To: to,
        From: options.from,
        Body: truncate(renderNotice(input), MAX_TEXT),
      });
      const result = await postForm(
        send,
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
          options.accountSid
        )}/Messages.json`,
        form,
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: {
            authorization,
            "idempotency-key": input.idempotencyKey,
          },
        }
      );
      return classifyHttp(result);
    },
  };
}

function recipient(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "to");
  return raw && /^\+?\d{7,20}$/.test(raw) ? raw : undefined;
}
