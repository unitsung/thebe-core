import { createHmac } from "node:crypto";
import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import { addressValue, classifyHttp, postJson } from "./shared.ts";

/**
 * POSTs the normalized notice to any HTTP endpoint. A target may carry a `secret`; when it does, the
 * exact body is signed with HMAC-SHA256 in `x-thebe-signature`. Bark, ntfy, Server酱, PushPlus, WxPusher
 * and a self-hosted gateway all fit behind this one adapter.
 */
export function createWebhookNotificationAdapter(
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "webhook",
    capabilities: { proactive: true, markdown: false },
    accepts(channel: ChannelRef): boolean {
      return webhookUrl(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const url = webhookUrl(input.target.channel.address);
      if (!url) {
        return { status: "discard", reason: "webhook_url_missing" };
      }
      const body = {
        version: 1,
        id: input.notification.id,
        category: input.notification.category,
        priority: input.notification.priority,
        title: input.notification.title,
        body: input.notification.body,
        ...(input.notification.deepLink
          ? { deepLink: input.notification.deepLink }
          : {}),
        ...(input.notification.ticketId
          ? { ticketId: input.notification.ticketId }
          : {}),
        ...(input.notification.goalId
          ? { goalId: input.notification.goalId }
          : {}),
        ...(input.notification.resource
          ? { resource: input.notification.resource }
          : {}),
        createdAt: input.notification.createdAt,
      };
      const text = JSON.stringify(body);
      const secret = addressValue(input.target.channel.address, "secret");
      const result = await postJson(send, url, body, {
        timeoutMs: options.timeoutMs ?? 10_000,
        headers: {
          "idempotency-key": input.idempotencyKey,
          "x-thebe-event": input.notification.id,
          ...(secret
            ? { "x-thebe-signature": `sha256=${hmac(secret, text)}` }
            : {}),
        },
      });
      return classifyHttp(result);
    },
  };
}

function webhookUrl(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "url");
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function hmac(secret: string, text: string): string {
  return createHmac("sha256", secret).update(text, "utf8").digest("hex");
}
