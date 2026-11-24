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

const DEFAULT_BASE = "https://bot-api.zaloplatforms.com";
const MAX_TEXT = 2_000;

/**
 * Zalo Bot API. This is the official Zalo bot platform, not a personal-account bridge. The bot token
 * and optional API base are host configuration; a target names a chat id. Zalo reports most failures
 * as HTTP 200 with `ok: false`, so the response body carries the real delivery result.
 */
export function createZaloNotificationAdapter(options: {
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  const base = (
    httpUrl(options.apiBaseUrl ?? DEFAULT_BASE) ?? DEFAULT_BASE
  ).replace(/\/$/, "");
  return {
    id: "zalo",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return chatId(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const recipient = chatId(input.target.channel.address);
      if (!recipient) return { status: "discard", reason: "zalo_chat_missing" };
      const result = await postJson(
        send,
        `${base}/bot${encodeURIComponent(options.token)}/sendMessage`,
        {
          chat_id: recipient,
          text: truncate(renderNotice(input), MAX_TEXT),
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: { "idempotency-key": input.idempotencyKey },
        }
      );
      const attempt = classifyHttp(result);
      if (result.kind !== "response" || !result.body) return attempt;
      const body = result.body as Record<string, unknown>;
      if (body.ok === true) return { status: "sent" };
      if (body.ok !== false) return attempt;
      const message =
        typeof body.description === "string"
          ? body.description.slice(0, 200)
          : "zalo refused the message";
      const code =
        typeof body.error_code === "number" ? body.error_code : undefined;
      if (code === 408 || code === 429 || (code !== undefined && code >= 500)) {
        return {
          status: "retry",
          reason: `zalo ${code}: ${message}`,
          ...(code === 429 ? { retryAfterMs: 60_000 } : {}),
        };
      }
      return {
        status: "discard",
        reason: code === undefined ? message : `zalo ${code}: ${message}`,
      };
    },
  };
}

function chatId(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "chatId");
  if (!raw || raw.length > 128 || /\s/.test(raw)) return undefined;
  return raw;
}
