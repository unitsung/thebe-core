import type { NotificationAdapter } from "../agent/notifications/types.ts";
import { createDingtalkNotificationAdapter } from "../adapters/notifications/dingtalk.ts";
import { createDiscordNotificationAdapter } from "../adapters/notifications/discord.ts";
import { createOpenClawNotificationAdapter } from "../adapters/notifications/openclaw.ts";
import { createSmtpNotificationAdapter } from "../adapters/notifications/smtp.ts";
import { createSlackNotificationAdapter } from "../adapters/notifications/slack.ts";
import { createTelegramNotificationAdapter } from "../adapters/notifications/telegram.ts";
import { createWebhookNotificationAdapter } from "../adapters/notifications/webhook.ts";
import { createWecomNotificationAdapter } from "../adapters/notifications/wecom.ts";

/**
 * Adapters whose credentials come from the host environment. A channel without its credential is not
 * registered at all, so a target pointing at it reports `adapter_missing` instead of failing every retry.
 */
export function createNotificationAdaptersFromEnv(
  env: NodeJS.ProcessEnv = process.env
): NotificationAdapter[] {
  const openclawGatewayUrl = env.THEBE_OPENCLAW_GATEWAY_URL?.trim();
  const openclawGatewayToken = env.THEBE_OPENCLAW_GATEWAY_TOKEN?.trim();
  const adapters: NotificationAdapter[] = [
    createWebhookNotificationAdapter(),
    createSlackNotificationAdapter(),
    createDiscordNotificationAdapter(),
    createOpenClawNotificationAdapter({
      bin: env.THEBE_OPENCLAW_BIN?.trim() || undefined,
      ...(openclawGatewayUrl
        ? {
            gateway: {
              url: openclawGatewayUrl,
              ...(openclawGatewayToken ? { token: openclawGatewayToken } : {}),
            },
          }
        : {}),
    }),
  ];

  const telegram = env.THEBE_TELEGRAM_BOT_TOKEN?.trim();
  if (telegram) {
    adapters.push(createTelegramNotificationAdapter({ botToken: telegram }));
  }

  const dingtalkUrl = env.THEBE_DINGTALK_WEBHOOK_URL?.trim();
  const dingtalkSecret = env.THEBE_DINGTALK_SECRET?.trim();
  if (dingtalkUrl) {
    adapters.push(
      createDingtalkNotificationAdapter({
        webhookUrl: dingtalkUrl,
        ...(dingtalkSecret ? { secret: dingtalkSecret } : {}),
      })
    );
  }

  const wecomUrl = env.THEBE_WECOM_WEBHOOK_URL?.trim();
  const corpId = env.THEBE_WECOM_CORP_ID?.trim();
  const corpSecret = env.THEBE_WECOM_CORP_SECRET?.trim();
  const agentId = env.THEBE_WECOM_AGENT_ID?.trim();
  if (wecomUrl || (corpId && corpSecret && agentId)) {
    adapters.push(
      createWecomNotificationAdapter({
        ...(wecomUrl ? { webhookUrl: wecomUrl } : {}),
        ...(corpId ? { corpId } : {}),
        ...(corpSecret ? { corpSecret } : {}),
        ...(agentId ? { agentId } : {}),
      })
    );
  }

  const smtpUrl = env.THEBE_SMTP_URL?.trim();
  const smtpFrom = env.THEBE_SMTP_FROM?.trim();
  if (smtpUrl && smtpFrom) {
    adapters.push(
      createSmtpNotificationAdapter({ url: smtpUrl, from: smtpFrom })
    );
  }

  return adapters;
}
