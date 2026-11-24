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

const DEFAULT_SERVER = "https://api.day.app";
const MAX_TITLE = 250;
const MAX_BODY = 4_000;

/**
 * Bark, the open-source iOS push app. The device key is the credential; a self-hosted Bark server is
 * selected with `server`. Critical notices use Bark's time-sensitive level so Focus does not hide them.
 */
export function createBarkNotificationAdapter(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "bark",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_BODY },
    accepts(channel: ChannelRef): boolean {
      return barkTarget(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const target = barkTarget(input.target.channel.address);
      if (!target) return { status: "discard", reason: "bark_key_missing" };
      const result = await postJson(
        send,
        `${target.server}/${encodeURIComponent(target.deviceKey)}`,
        {
          title: truncate(input.notification.title, MAX_TITLE),
          body: truncate(renderNotice(input, { link: false }), MAX_BODY),
          group: "thebe",
          level: levelFor(input),
          ...(input.notification.deepLink
            ? { url: input.notification.deepLink }
            : {}),
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: { "idempotency-key": input.idempotencyKey },
        }
      );
      const attempt = classifyHttp(result);
      if (
        attempt.status === "sent" &&
        result.kind === "response" &&
        result.body &&
        typeof result.body === "object"
      ) {
        const code = (result.body as Record<string, unknown>).code;
        if (typeof code === "number" && code !== 200) {
          const message =
            typeof (result.body as Record<string, unknown>).message === "string"
              ? String((result.body as Record<string, unknown>).message).slice(
                  0,
                  200
                )
              : "bark refused the notice";
          return { status: "discard", reason: `bark ${code}: ${message}` };
        }
      }
      return attempt;
    },
  };
}

function barkTarget(
  address: Record<string, string> | undefined
): { server: string; deviceKey: string } | undefined {
  const deviceKey = addressValue(address, "deviceKey");
  if (!deviceKey || !/^[A-Za-z0-9_-]{6,128}$/.test(deviceKey)) return undefined;
  const server = httpUrl(addressValue(address, "server") ?? DEFAULT_SERVER);
  if (!server) return undefined;
  return { server: server.replace(/\/$/, ""), deviceKey };
}

function levelFor(input: NotificationSendInput): string {
  if (input.notification.priority === "critical") return "timeSensitive";
  if (input.notification.priority === "low") return "passive";
  return "active";
}
