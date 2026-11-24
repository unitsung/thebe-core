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
 * Gotify, the self-hosted push server. The application token is a target credential (the settings file
 * is owner-only and reads mask it); a host-wide server URL may be supplied instead of repeating it.
 */
export function createGotifyNotificationAdapter(
  options: {
    url?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "gotify",
    capabilities: { proactive: true, markdown: true, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return gotifyTarget(channel.address, options) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const target = gotifyTarget(input.target.channel.address, options);
      if (!target)
        return { status: "discard", reason: "gotify_target_missing" };
      const result = await postJson(
        send,
        `${target.server}/message`,
        {
          title: truncate(input.notification.title, 250),
          message: truncate(renderNotice(input), MAX_TEXT),
          priority: priorityFor(input),
          extras: {
            "client::display": { contentType: "text/markdown" },
          },
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: {
            "X-Gotify-Key": target.token,
            "idempotency-key": input.idempotencyKey,
          },
        }
      );
      return classifyHttp(result);
    },
  };
}

function gotifyTarget(
  address: Record<string, string> | undefined,
  options: { url?: string }
): { server: string; token: string } | undefined {
  const token = addressValue(address, "token");
  if (!token || token.length > 512) return undefined;
  const server = httpUrl(addressValue(address, "url") ?? options.url);
  if (!server) return undefined;
  return { server: server.replace(/\/$/, ""), token };
}

function priorityFor(input: NotificationSendInput): number {
  if (input.notification.priority === "critical") return 8;
  if (input.notification.priority === "low") return 2;
  return 5;
}
