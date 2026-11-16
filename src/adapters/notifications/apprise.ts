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

const MAX_TEXT = 32_000;

/**
 * Apprise API, the optional bridge to the many services Apprise supports (ntfy, Bark, Matrix, Teams,
 * SMS and more). Core sends to a saved Apprise configuration key; it does not embed the Python runtime
 * or accept raw service URLs in a target, where their embedded tokens would be easy to leak.
 */
export function createAppriseNotificationAdapter(options: {
  url: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  const base = httpUrl(options.url)?.replace(/\/$/, "");
  return {
    id: "apprise",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return (
        base !== undefined && configKey(channel.address, options) !== undefined
      );
    },
    async send(input: NotificationSendInput) {
      const key = configKey(input.target.channel.address, options);
      if (!base || !key) {
        return { status: "discard", reason: "apprise_key_missing" };
      }
      const result = await postJson(
        send,
        `${base}/notify/${encodeURIComponent(key)}`,
        {
          title: truncate(input.notification.title, 250),
          body: truncate(renderNotice(input), MAX_TEXT),
          type: typeFor(input),
          format: "text",
        },
        {
          timeoutMs: options.timeoutMs ?? 15_000,
          headers: {
            accept: "application/json",
            "idempotency-key": input.idempotencyKey,
          },
        }
      );
      return classifyHttp(result, {
        retryStatuses: [424],
        detail: "apprise could not reach every destination",
      });
    },
  };
}

function configKey(
  address: Record<string, string> | undefined,
  options: { token?: string }
): string | undefined {
  const key = addressValue(address, "token") ?? options.token?.trim();
  if (!key || key.length > 128) return undefined;
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : undefined;
}

function typeFor(input: NotificationSendInput): string {
  if (input.notification.priority === "critical") return "failure";
  if (input.notification.category === "completed") return "success";
  if (input.notification.category === "source_health") return "warning";
  return "info";
}
