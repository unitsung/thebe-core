import { createImGateway, type ImGatewayAgent } from "../agent/im/gateway.ts";
import type { ImAdapterFactory } from "../agent/im/types.ts";
import {
  createTelegramImAdapter,
  telegramCursorIdentity,
  validateTelegramCredentials,
} from "../adapters/im/telegram.ts";
import { createWechatFactory } from "../adapters/im/wechat/adapter.ts";
import { redactToolOutput } from "../agent/security/redaction.ts";

/**
 * Composes the IM gateway from host configuration. A Telegram bot token in the environment becomes an
 * environment-owned channel; other channels are added at runtime and their credentials are written to
 * the owner-only `im-secrets.json` beside the IM state.
 */
export function createImIntegration(options: {
  agent: ImGatewayAgent;
  dir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  factories?: readonly ImAdapterFactory[];
  onError?: (error: unknown) => void;
}) {
  const env = options.env ?? {};
  const now = options.now ?? (() => new Date());
  // Host factories come first so a host can replace the built-in Telegram adapter.
  const factories: ImAdapterFactory[] = [
    ...(options.factories ?? []),
    telegramFactory(env),
    createWechatFactory(env),
  ];
  const token = env.THEBE_TELEGRAM_BOT_TOKEN?.trim();
  const seed = token
    ? [
        {
          account: {
            id: "telegram-env",
            platform: "telegram" as const,
            label: "Telegram (environment)",
            enabled: true,
            createdAt: now().toISOString(),
          },
          credentials: { token },
        },
      ]
    : [];
  return createImGateway({
    agent: options.agent,
    ...(options.dir ? { dir: options.dir } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    factories,
    seed,
    now,
    onError:
      options.onError ??
      ((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[im]", redactToolOutput(message));
      }),
  });
}

function telegramFactory(env: NodeJS.ProcessEnv): ImAdapterFactory {
  const apiBase = env.THEBE_TELEGRAM_API_BASE?.trim() || undefined;
  const poll = Number(env.THEBE_TELEGRAM_POLL_TIMEOUT?.trim());
  const pollTimeoutSeconds =
    Number.isFinite(poll) && poll >= 1 && poll <= 50 ? poll : undefined;
  return {
    platform: "telegram",
    credentials: [
      { key: "token", label: "Bot token", required: true, secret: true },
    ],
    validateCredentials: validateTelegramCredentials,
    cursorIdentity: telegramCursorIdentity,
    create: (input) =>
      createTelegramImAdapter({
        account: input.account,
        credentials: input.credentials,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        onCursor: input.onCursor,
        ...(input.onError ? { onError: input.onError } : {}),
        ...(input.fetch ? { fetch: input.fetch } : {}),
        ...(input.now ? { now: input.now } : {}),
        ...(apiBase ? { apiBase } : {}),
        ...(pollTimeoutSeconds ? { pollTimeoutSeconds } : {}),
      }),
  };
}
