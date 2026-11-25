import { createImGateway, type ImGatewayAgent } from "../agent/im/gateway.ts";
import type {
  ImAccount,
  ImAdapterCredentials,
  ImAdapterFactory,
} from "../agent/im/types.ts";
import {
  createTelegramImAdapter,
  telegramCursorIdentity,
  validateTelegramCredentials,
} from "../adapters/im/telegram.ts";
import { createWechatFactory } from "../adapters/im/wechat/adapter.ts";
import { createQqFactory } from "../adapters/im/qq.ts";
import { createImessageFactory } from "../adapters/im/imessage.ts";
import { redactToolOutput } from "../agent/security/redaction.ts";

/**
 * Composes the IM gateway from host configuration. A Telegram token, QQ AppID/AppSecret or
 * BlueBubbles server in the environment becomes an environment-owned channel; other channels are
 * added at runtime and their credentials are written to the owner-only `im-secrets.json` beside the
 * IM state.
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
  // Host factories come first so a host can replace a built-in adapter.
  const factories: ImAdapterFactory[] = [
    ...(options.factories ?? []),
    telegramFactory(env),
    createWechatFactory(env),
    createQqFactory(env),
    createImessageFactory(env),
  ];
  const seed: Array<{
    account: ImAccount;
    credentials: ImAdapterCredentials;
  }> = [];
  const token = env.THEBE_TELEGRAM_BOT_TOKEN?.trim();
  if (token) {
    seed.push({
      account: {
        id: "telegram-env",
        platform: "telegram",
        label: "Telegram (environment)",
        enabled: true,
        createdAt: now().toISOString(),
      },
      credentials: { token },
    });
  }
  const qqAppId = env.THEBE_QQ_APP_ID?.trim();
  const qqSecret = env.THEBE_QQ_APP_SECRET?.trim();
  if (qqAppId && qqSecret) {
    seed.push({
      account: {
        id: "qq-env",
        platform: "qq",
        label: "QQ (environment)",
        enabled: true,
        createdAt: now().toISOString(),
      },
      credentials: { appId: qqAppId, clientSecret: qqSecret },
    });
  }
  const imessageBaseUrl =
    env.THEBE_IMESSAGE_BASE_URL?.trim() || env.THEBE_BLUEBUBBLES_URL?.trim();
  const imessagePassword =
    env.THEBE_IMESSAGE_PASSWORD?.trim() ||
    env.THEBE_BLUEBUBBLES_PASSWORD?.trim();
  const imessageBackend = env.THEBE_IMESSAGE_BACKEND?.trim().toLowerCase();
  const imsgPath = env.THEBE_IMSG_PATH?.trim();
  if (
    imessageBackend === "imsg" ||
    imessageBackend === "local" ||
    (!imessageBaseUrl && imsgPath)
  ) {
    seed.push({
      account: {
        id: "imessage-imsg-env",
        platform: "imessage",
        label: "iMessage imsg (environment)",
        enabled: true,
        createdAt: now().toISOString(),
      },
      credentials: {
        backend: "imsg",
        ...(imsgPath ? { cliPath: imsgPath } : {}),
        ...(env.THEBE_IMSG_DB_PATH?.trim()
          ? { dbPath: env.THEBE_IMSG_DB_PATH.trim() }
          : {}),
      },
    });
  } else if (imessageBaseUrl && imessagePassword) {
    seed.push({
      account: {
        id: "imessage-env",
        platform: "imessage",
        label: "iMessage (environment)",
        enabled: true,
        createdAt: now().toISOString(),
      },
      credentials: {
        backend: "bluebubbles",
        baseUrl: imessageBaseUrl,
        password: imessagePassword,
      },
    });
  }
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
