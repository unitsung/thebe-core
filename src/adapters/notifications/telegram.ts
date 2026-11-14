import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import { addressValue, classifyHttp, postJson, truncate } from "./shared.ts";

const MAX_TEXT = 4_096;

/** Telegram Bot API. The bot token is host configuration, never part of a notification target. */
export function createTelegramNotificationAdapter(options: {
  botToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): NotificationAdapter {
  const send = options.fetch ?? fetch;
  const endpoint = `https://api.telegram.org/bot${options.botToken}/sendMessage`;
  return {
    id: "telegram",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return telegramChatId(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const chatId = telegramChatId(input.target.channel.address);
      if (!chatId) return { status: "discard", reason: "chat_id_missing" };
      const threadId = numeric(
        addressValue(input.target.channel.address, "threadId")
      );
      const text = truncate(render(input), MAX_TEXT);
      const result = await postJson(
        send,
        endpoint,
        {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          ...(threadId ? { message_thread_id: threadId } : {}),
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: { "idempotency-key": input.idempotencyKey },
        }
      );
      const attempt = classifyHttp(result, {
        detail: telegramDetail(result),
      });
      if (
        result.kind === "response" &&
        result.body &&
        typeof result.body === "object" &&
        (result.body as Record<string, unknown>).ok === false
      ) {
        const body = result.body as Record<string, unknown>;
        const description =
          typeof body.description === "string"
            ? body.description.slice(0, 200)
            : "telegram refused the message";
        if (body.error_code === 429 || result.response.status === 429) {
          return withTelegramRetry(
            { status: "retry", reason: description },
            result
          );
        }
        return { status: "discard", reason: description };
      }
      return withTelegramRetry(attempt, result);
    },
  };
}

function render(input: NotificationSendInput): string {
  const lines = [input.notification.title, input.notification.body];
  if (input.notification.deepLink) lines.push(input.notification.deepLink);
  return lines.join("\n\n");
}

function telegramChatId(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "chatId");
  if (!raw) return undefined;
  return /^-?\d{1,20}$/.test(raw) || /^@[A-Za-z0-9_]{3,64}$/.test(raw)
    ? raw
    : undefined;
}

function numeric(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function telegramDetail(
  result: Awaited<ReturnType<typeof postJson>>
): string | undefined {
  if (
    result.kind !== "response" ||
    !result.body ||
    typeof result.body !== "object"
  ) {
    return undefined;
  }
  const body = result.body as Record<string, unknown>;
  const description = body.description;
  return typeof description === "string"
    ? description.slice(0, 200)
    : undefined;
}

function withTelegramRetry(
  attempt: ReturnType<typeof classifyHttp>,
  result: Awaited<ReturnType<typeof postJson>>
): ReturnType<typeof classifyHttp> {
  if (attempt.status !== "retry" || result.kind !== "response") {
    return attempt;
  }
  const body = result.body;
  if (!body || typeof body !== "object") return attempt;
  const parameters = (body as Record<string, unknown>).parameters;
  if (!parameters || typeof parameters !== "object") return attempt;
  const seconds = (parameters as Record<string, unknown>).retry_after;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return attempt;
  return {
    ...attempt,
    retryAfterMs: Math.max(1_000, Math.min(seconds * 1_000, 5 * 60_000)),
  };
}
