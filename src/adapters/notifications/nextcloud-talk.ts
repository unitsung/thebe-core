import { createHmac, randomBytes } from "node:crypto";
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
 * Nextcloud Talk bot API. The bot secret is host configuration and every message is signed with
 * HMAC-SHA256 over the random value and the exact message text. The bot must be installed with the
 * `response` feature; Talk rejects unsigned or uninstalled bots.
 */
export function createNextcloudTalkNotificationAdapter(options: {
  url: string;
  botSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  const base = httpUrl(options.url)?.replace(/\/$/, "");
  return {
    id: "nextcloud-talk",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return base !== undefined && roomToken(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const room = roomToken(input.target.channel.address);
      if (!base || !room) {
        return { status: "discard", reason: "nextcloud_room_missing" };
      }
      const message = truncate(renderNotice(input), MAX_TEXT);
      const random = randomBytes(32).toString("hex");
      const signature = createHmac("sha256", options.botSecret)
        .update(random + message)
        .digest("hex");
      const result = await postJson(
        send,
        `${base}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(
          room
        )}/message`,
        { message },
        {
          timeoutMs: options.timeoutMs ?? 15_000,
          headers: {
            "OCS-APIRequest": "true",
            "X-Nextcloud-Talk-Bot-Random": random,
            "X-Nextcloud-Talk-Bot-Signature": signature,
            "idempotency-key": input.idempotencyKey,
          },
        }
      );
      const attempt = classifyHttp(result);
      if (result.kind !== "response" || !result.body) return attempt;
      const body = result.body as Record<string, unknown>;
      const ocs =
        body.ocs && typeof body.ocs === "object"
          ? (body.ocs as Record<string, unknown>)
          : undefined;
      const meta =
        ocs?.meta && typeof ocs.meta === "object"
          ? (ocs.meta as Record<string, unknown>)
          : undefined;
      const status = numeric(meta?.statuscode);
      if (status !== undefined && status >= 400) {
        const detail =
          typeof meta?.message === "string"
            ? meta.message.slice(0, 200)
            : "nextcloud talk refused the message";
        if (
          status === 408 ||
          status === 425 ||
          status === 429 ||
          status >= 500
        ) {
          return {
            status: "retry",
            reason: `nextcloud_talk ${status}: ${detail}`,
            ...(status === 429 ? { retryAfterMs: 60_000 } : {}),
          };
        }
        return {
          status: "discard",
          reason: `nextcloud_talk ${status}: ${detail}`,
        };
      }
      return { status: "sent" };
    },
  };
}

function roomToken(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "roomToken");
  if (!raw || raw.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(raw)) {
    return undefined;
  }
  return raw;
}

function numeric(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
