import { createHmac } from "node:crypto";
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

const MAX_TEXT = 10_000;
const RATE_LIMIT_CODES = new Set([9499, 11232]);

/**
 * Feishu (Lark) custom bot webhook. This is the owner-configured notification path; the Feishu Source's
 * ticket channel keeps its own `feishu` adapter and app credentials. A signing secret is applied exactly
 * as Feishu documents it.
 */
export function createFeishuWebhookNotificationAdapter(
  options: {
    webhookUrl?: string;
    secret?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "feishu-webhook",
    capabilities: {
      proactive: true,
      markdown: false,
      maxTextLength: MAX_TEXT,
    },
    accepts(channel: ChannelRef): boolean {
      return feishuUrl(channel.address, options) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const url = feishuUrl(input.target.channel.address, options);
      if (!url) return { status: "discard", reason: "feishu_url_missing" };
      const secret =
        addressValue(input.target.channel.address, "secret") ?? options.secret;
      const timestamp = Math.floor(Date.now() / 1_000).toString();
      const body = {
        msg_type: "text",
        content: {
          text: truncate(renderNotice(input), MAX_TEXT),
        },
        ...(secret ? { timestamp, sign: sign(secret, timestamp) } : {}),
      };
      const result = await postJson(send, url, body, {
        timeoutMs: options.timeoutMs ?? 10_000,
        headers: { "idempotency-key": input.idempotencyKey },
      });
      const attempt = classifyHttp(result);
      if (result.kind !== "response" || !result.body) return attempt;
      const row = result.body as Record<string, unknown>;
      const code =
        typeof row.code === "number"
          ? row.code
          : typeof row.StatusCode === "number"
            ? row.StatusCode
            : undefined;
      if (code === 0) return { status: "sent" };
      if (code === undefined) return attempt;
      const message =
        typeof row.msg === "string"
          ? row.msg.slice(0, 200)
          : typeof row.StatusMessage === "string"
            ? row.StatusMessage.slice(0, 200)
            : "feishu refused the notice";
      const reason = `feishu ${code}: ${message}`;
      if (RATE_LIMIT_CODES.has(code)) {
        return { status: "retry", reason, retryAfterMs: 60_000 };
      }
      return { status: "discard", reason };
    },
  };
}

function feishuUrl(
  address: Record<string, string> | undefined,
  options: { webhookUrl?: string }
): string | undefined {
  return httpUrl(
    addressValue(address, "url") ??
      addressValue(address, "webhookUrl") ??
      options.webhookUrl
  );
}

function sign(secret: string, timestamp: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`)
    .update("")
    .digest("base64");
}
