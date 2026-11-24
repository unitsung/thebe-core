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

const MAX_TEXT = 32_000;

/**
 * Matrix client-server API. The homeserver and access token are host configuration; a target names a
 * room id or alias. The event id is derived from the outbox key, so Matrix deduplicates a retry.
 */
export function createMatrixNotificationAdapter(options: {
  homeserverUrl: string;
  accessToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  const homeserver = httpUrl(options.homeserverUrl)?.replace(/\/$/, "");
  return {
    id: "matrix",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return homeserver !== undefined && roomId(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const room = roomId(input.target.channel.address);
      if (!homeserver || !room) {
        return { status: "discard", reason: "matrix_room_missing" };
      }
      const transaction = createHash("sha256")
        .update(input.idempotencyKey)
        .digest("hex");
      const result = await postJson(
        send,
        `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(
          room
        )}/send/m.room.message/${transaction}`,
        {
          msgtype: "m.text",
          body: truncate(renderNotice(input), MAX_TEXT),
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          method: "PUT",
          headers: {
            authorization: `Bearer ${options.accessToken}`,
            "idempotency-key": input.idempotencyKey,
          },
        }
      );
      const attempt = classifyHttp(result);
      if (result.kind !== "response" || !result.body) return attempt;
      const body = result.body as Record<string, unknown>;
      if (typeof body.event_id === "string") return { status: "sent" };
      const error =
        typeof body.error === "string"
          ? body.error.slice(0, 200)
          : "matrix refused the event";
      if (result.response.status === 429) {
        const retry = matrixRetry(body);
        return {
          status: "retry",
          reason: error,
          ...(retry ? { retryAfterMs: retry } : {}),
        };
      }
      return { status: "discard", reason: error };
    },
  };
}

function matrixRetry(body: Record<string, unknown>): number | undefined {
  const retry = body.retry_after_ms;
  if (typeof retry !== "number" || !Number.isFinite(retry) || retry < 0) {
    return undefined;
  }
  return Math.max(1_000, Math.min(retry, 5 * 60_000));
}

function roomId(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "roomId");
  if (!raw || raw.length > 255) return undefined;
  return /^[!#][^\s]+:[^\s]+$/.test(raw) ? raw : undefined;
}
