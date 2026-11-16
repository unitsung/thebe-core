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

const MAX_TEXT = 2_000;

/**
 * Signal through signal-cli-rest-api. Core never implements the Signal protocol; it talks to the
 * linked-device REST bridge, which holds the account. The sender number is host configuration.
 */
export function createSignalNotificationAdapter(options: {
  url: string;
  number: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  const base = httpUrl(options.url)?.replace(/\/$/, "");
  return {
    id: "signal",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return base !== undefined && recipients(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const to = recipients(input.target.channel.address);
      if (!base || !to) {
        return { status: "discard", reason: "signal_recipients_missing" };
      }
      const result = await postJson(
        send,
        `${base}/v2/send`,
        {
          number: options.number,
          recipients: to,
          message: truncate(renderNotice(input), MAX_TEXT),
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

function recipients(
  address: Record<string, string> | undefined
): string[] | undefined {
  const raw = addressValue(address, "recipients");
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length > 50) return undefined;
  return values.every(isRecipient) ? values : undefined;
}

function isRecipient(value: string): boolean {
  return (
    /^\+?\d{5,20}$/.test(value) ||
    /^group\.[A-Za-z0-9+/=_-]{10,200}$/.test(value)
  );
}
