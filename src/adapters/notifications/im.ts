import type { ImChat } from "../../agent/im/types.ts";
import type { ImGateway } from "../../agent/im/gateway.ts";
import type {
  NotificationAdapter,
  NotificationDeliveryAttempt,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";

const FALLBACK_MAX_TEXT = 4_096;
const FALLBACK_REPLY_WINDOW_MS = 5 * 60_000;

type ImAddress = {
  accountId: string;
  chat: Pick<ImChat, "kind" | "id" | "threadId">;
};

/**
 * A notification target that sends through the two-way IM gateway. Only an adapter that advertises
 * proactive delivery can be used for an unsolicited notice; a reply-only channel has no durable
 * destination and is discarded as `window_closed` instead of being queued for days. The target address
 * is `source: "im"` plus `accountId`, `chatKind`, `chatId` and an optional `threadId`.
 */
export function createImNotificationAdapter(options: {
  im: ImGateway;
  now?: () => Date;
}): NotificationAdapter {
  const now = options.now ?? (() => new Date());
  return {
    id: "im",
    capabilities: {
      proactive: true,
      markdown: false,
      maxTextLength: 10_000,
    },
    accepts(channel: ChannelRef): boolean {
      return parseImAddress(channel) !== undefined;
    },
    async send(
      input: NotificationSendInput
    ): Promise<NotificationDeliveryAttempt> {
      const address = parseImAddress(input.target.channel);
      if (!address) {
        return { status: "discard", reason: "invalid_im_address" };
      }
      try {
        await options.im.start();
      } catch {
        // Startup can fail transiently (for example, the IM state store is unavailable).
        return { status: "retry", reason: "im_unavailable" };
      }
      const capabilities = options.im.capabilitiesFor(address.accountId);
      if (!capabilities) {
        return { status: "discard", reason: "unknown_im_account" };
      }
      const text = formatImNotice(
        input,
        capabilities.maxTextLength ?? FALLBACK_MAX_TEXT
      );
      if (!capabilities.proactive) {
        // QQ and Weixin can send one more reply only while the inbound window is open.
        const anchor = options.im.replyAnchor(address.accountId, address.chat);
        if (!anchor) {
          return { status: "discard", reason: "window_closed" };
        }
        const received = Date.parse(anchor.receivedAt);
        const windowMs =
          options.im.replyWindowMsFor?.(address.accountId, address.chat) ??
          capabilities.replyWindowMs ??
          FALLBACK_REPLY_WINDOW_MS;
        if (
          !Number.isFinite(received) ||
          now().getTime() - received > windowMs
        ) {
          return { status: "discard", reason: "window_closed" };
        }
        try {
          const result = await options.im.send({
            accountId: address.accountId,
            chat: address.chat,
            text,
            mode: "reply",
            ...(anchor.replyTo ? { replyTo: anchor.replyTo } : {}),
            ...(anchor.contextToken
              ? { contextToken: anchor.contextToken }
              : {}),
            idempotencyKey: input.idempotencyKey,
          });
          return notificationResult(result);
        } catch {
          return { status: "discard", reason: "unknown_im_account" };
        }
      }
      try {
        const result = await options.im.send({
          accountId: address.accountId,
          chat: address.chat,
          text,
          mode: "proactive",
          idempotencyKey: input.idempotencyKey,
        });
        return notificationResult(result);
      } catch {
        // An account removed between selection and delivery is permanent, not retryable.
        return { status: "discard", reason: "unknown_im_account" };
      }
    },
  };
}

function parseImAddress(channel: ChannelRef): ImAddress | undefined {
  if (channel.source !== "im") return undefined;
  const address = channel.address ?? {};
  const accountId = clean(address.accountId);
  const chatId = clean(address.chatId);
  const kind = address.chatKind;
  if (!accountId || !chatId) return undefined;
  if (kind !== "direct" && kind !== "group") return undefined;
  const threadId = clean(address.threadId);
  return {
    accountId,
    chat: {
      kind,
      id: chatId,
      ...(threadId ? { threadId } : {}),
    },
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function notificationResult(input: {
  status: "sent" | "retry" | "discard" | "unknown";
  reason?: string;
  retryAfterMs?: number;
}): NotificationDeliveryAttempt {
  switch (input.status) {
    case "sent":
      return { status: "sent" };
    case "retry":
      return {
        status: "retry",
        reason: input.reason ?? "im_send_failed",
        ...(input.retryAfterMs !== undefined
          ? { retryAfterMs: input.retryAfterMs }
          : {}),
      };
    case "discard":
      return { status: "discard", reason: input.reason ?? "im_refused" };
    case "unknown":
      return { status: "unknown", reason: input.reason ?? "im_unknown" };
  }
}

function formatImNotice(
  input: NotificationSendInput,
  maxTextLength: number
): string {
  const title = input.notification.title.trim();
  const body = input.notification.body.trim();
  const link = input.notification.deepLink?.trim();
  const text = [title, body, link].filter(Boolean).join("\n\n");
  if (text.length <= maxTextLength) return text;
  if (!link) {
    return `${text.slice(0, Math.max(0, maxTextLength - 1))}…`;
  }
  const suffix = `\n\n${link}`;
  const budget = Math.max(0, maxTextLength - suffix.length - 1);
  const head = [title, body].filter(Boolean).join("\n\n");
  return `${head.slice(0, budget)}…${suffix}`;
}
