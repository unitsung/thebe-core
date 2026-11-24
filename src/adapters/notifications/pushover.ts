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

const ENDPOINT = "https://api.pushover.net/1/messages.json";
const MAX_TITLE = 250;
const MAX_MESSAGE = 1_024;

/**
 * Pushover. The application token is host configuration; a target names the person or group key.
 * Emergency priority is deliberately not used: it requires a receipt loop Core does not run.
 */
export function createPushoverNotificationAdapter(options: {
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "pushover",
    capabilities: {
      proactive: true,
      markdown: false,
      maxTextLength: MAX_MESSAGE,
    },
    accepts(channel: ChannelRef): boolean {
      return userKey(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const user = userKey(input.target.channel.address);
      if (!user) return { status: "discard", reason: "pushover_user_missing" };
      const form = new URLSearchParams({
        token: options.token,
        user,
        title: truncate(input.notification.title, MAX_TITLE),
        message: truncate(renderNotice(input, { link: false }), MAX_MESSAGE),
        priority: String(priorityFor(input)),
        ...(input.notification.deepLink
          ? { url: input.notification.deepLink, url_title: "Open" }
          : {}),
      });
      const result = await postForm(send, ENDPOINT, form, {
        timeoutMs: options.timeoutMs ?? 10_000,
        headers: { "idempotency-key": input.idempotencyKey },
      });
      const attempt = classifyHttp(result);
      if (result.kind !== "response" || !result.body) return attempt;
      const row = result.body as Record<string, unknown>;
      if (row.status === 1) return { status: "sent" };
      if (result.response.ok && row.status !== 1) {
        const errors = Array.isArray(row.errors)
          ? row.errors
              .filter((item): item is string => typeof item === "string")
              .join("; ")
              .slice(0, 200)
          : "pushover refused the notice";
        return { status: "discard", reason: errors };
      }
      return attempt;
    },
  };
}

function userKey(
  address: Record<string, string> | undefined
): string | undefined {
  const user = addressValue(address, "user");
  return user && /^[A-Za-z0-9]{20,40}$/.test(user) ? user : undefined;
}

function priorityFor(input: NotificationSendInput): number {
  if (input.notification.priority === "critical") return 1;
  if (input.notification.priority === "low") return -1;
  return 0;
}
