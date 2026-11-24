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

const DEFAULT_SERVER = "https://ntfy.sh";
const MAX_TEXT = 4_096;
const MAX_TITLE = 250;

/**
 * ntfy publishes to a topic over plain HTTP. A target names a topic and may use the public server or
 * a self-hosted one; a token is sent as a Bearer credential and never appears in the URL.
 */
export function createNtfyNotificationAdapter(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  return {
    id: "ntfy",
    capabilities: {
      proactive: true,
      markdown: true,
      maxTextLength: MAX_TEXT,
    },
    accepts(channel: ChannelRef): boolean {
      return ntfyTarget(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const target = ntfyTarget(input.target.channel.address);
      if (!target) return { status: "discard", reason: "ntfy_topic_missing" };
      const result = await postJson(
        send,
        target.server,
        {
          topic: target.topic,
          title: truncate(input.notification.title, MAX_TITLE),
          message: truncate(renderNotice(input), MAX_TEXT),
          priority: priorityFor(input),
          tags: [input.notification.category],
          ...(input.notification.deepLink
            ? { click: input.notification.deepLink }
            : {}),
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: {
            "idempotency-key": input.idempotencyKey,
            ...(target.token
              ? { authorization: `Bearer ${target.token}` }
              : {}),
          },
        }
      );
      return classifyHttp(result);
    },
  };
}

function ntfyTarget(
  address: Record<string, string> | undefined
): { server: string; topic: string; token?: string } | undefined {
  const raw = httpUrl(addressValue(address, "url") ?? DEFAULT_SERVER);
  if (!raw) return undefined;
  const url = new URL(raw);
  const explicit = addressValue(address, "topic");
  const topic = explicit ?? lastPathSegment(url);
  if (!topic || !/^[-_A-Za-z0-9]{1,64}$/.test(topic)) return undefined;
  // With a topic in the address, `url` is the server root, including any reverse-proxy subpath.
  // A pasted topic URL is split into its origin and last path segment.
  const server = explicit ? url.toString().replace(/\/$/, "") : url.origin;
  const token = addressValue(address, "token");
  return { server, topic, ...(token ? { token } : {}) };
}

function lastPathSegment(url: URL): string | undefined {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  try {
    return decodeURIComponent(segments.at(-1)!);
  } catch {
    return undefined;
  }
}

function priorityFor(input: NotificationSendInput): number {
  if (input.notification.priority === "critical") return 5;
  if (input.notification.priority === "low") return 2;
  return 3;
}
