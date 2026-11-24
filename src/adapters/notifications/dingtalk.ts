import { createHmac } from "node:crypto";
import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import { addressValue, classifyHttp, postJson, truncate } from "./shared.ts";

const MAX_TEXT = 20_000;

/**
 * DingTalk custom robot. The access token may live in the target address (it is a credential and the
 * settings file is owner-only) or in host configuration. When a signing secret is present, the webhook
 * query carries `timestamp` and `sign` exactly as DingTalk documents.
 */
export function createDingtalkNotificationAdapter(
  options: {
    webhookUrl?: string;
    secret?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "dingtalk",
    capabilities: { proactive: true, markdown: true, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return dingtalkUrl(channel.address, options) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const raw = dingtalkUrl(input.target.channel.address, options);
      if (!raw) return { status: "discard", reason: "dingtalk_url_missing" };
      const secret =
        addressValue(input.target.channel.address, "secret") ?? options.secret;
      const url = secret ? signedUrl(raw, secret) : raw;
      const title = truncate(input.notification.title, 100);
      const text = truncate(
        [
          `### ${input.notification.title}`,
          "",
          input.notification.body,
          ...(input.notification.deepLink
            ? ["", `[Open](${input.notification.deepLink})`]
            : []),
        ].join("\n"),
        MAX_TEXT
      );
      const result = await postJson(
        send,
        url,
        { msgtype: "markdown", markdown: { title, text } },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: { "idempotency-key": input.idempotencyKey },
        }
      );
      const attempt = classifyHttp(result);
      if (result.kind !== "response" || !result.body) return attempt;
      const body = result.body as Record<string, unknown>;
      const errcode = body.errcode;
      if (errcode === 0) return { status: "sent" };
      if (typeof errcode !== "number") return attempt;
      const message =
        typeof body.errmsg === "string" ? body.errmsg.slice(0, 200) : "";
      const reason = `dingtalk error ${errcode}${message ? `: ${message}` : ""}`;
      if (errcode === 130101) {
        return { status: "retry", reason, retryAfterMs: 60_000 };
      }
      if (errcode === 310000 || errcode === 300001) {
        return { status: "discard", reason };
      }
      if (result.response.ok) {
        return { status: "discard", reason };
      }
      return { status: "retry", reason };
    },
  };
}

function dingtalkUrl(
  address: Record<string, string> | undefined,
  options: { webhookUrl?: string }
): string | undefined {
  const direct =
    addressValue(address, "url") ?? addressValue(address, "webhookUrl");
  if (direct && isHttp(direct)) return direct;
  const token = addressValue(address, "accessToken");
  if (token) {
    return `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(token)}`;
  }
  return options.webhookUrl && isHttp(options.webhookUrl)
    ? options.webhookUrl
    : undefined;
}

function signedUrl(raw: string, secret: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const timestamp = Date.now();
  const sign = createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`, "utf8")
    .digest("base64");
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  return url.toString();
}

function isHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
