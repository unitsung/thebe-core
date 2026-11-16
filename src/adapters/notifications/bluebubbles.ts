import { createHash } from "node:crypto";
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

/**
 * iMessage through a BlueBubbles server on a Mac that stays online. The server URL and password are
 * host configuration; a target names one chat GUID (`iMessage;-;15550103` or a group GUID). AppleScript
 * sends often answer slowly, so a timeout is `unknown`, never a safe retry.
 */
export function createBlueBubblesNotificationAdapter(options: {
  url: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  const base = httpUrl(options.url)?.replace(/\/$/, "");
  return {
    id: "bluebubbles",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return base !== undefined && chatGuid(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const guid = chatGuid(input.target.channel.address);
      if (!base || !guid) {
        return { status: "discard", reason: "bluebubbles_chat_missing" };
      }
      const result = await postJson(
        send,
        `${base}/api/v1/message/text?password=${encodeURIComponent(
          options.password
        )}`,
        {
          chatGuid: guid,
          tempGuid: createHash("sha256")
            .update(input.idempotencyKey)
            .digest("hex"),
          message: truncate(renderNotice(input), MAX_TEXT),
          method: "apple-script",
        },
        {
          timeoutMs: options.timeoutMs ?? 15_000,
          headers: { "idempotency-key": input.idempotencyKey },
        }
      );
      const attempt = classifyHttp(result);
      if (result.kind !== "response" || !result.body) return attempt;
      const body = result.body as Record<string, unknown>;
      if (body.status === 200) return { status: "sent" };
      if (typeof body.status === "number") {
        const message =
          typeof body.message === "string"
            ? body.message.slice(0, 200)
            : "bluebubbles refused the message";
        return { status: "discard", reason: message };
      }
      return attempt;
    },
  };
}

function chatGuid(
  address: Record<string, string> | undefined
): string | undefined {
  const raw =
    addressValue(address, "chatGuid") ?? addressValue(address, "chat_guid");
  if (!raw || raw.length > 255 || /\s/.test(raw)) return undefined;
  return raw;
}
