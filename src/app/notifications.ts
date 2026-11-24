import type { NotificationChannelConfig } from "../agent/notifications/channel-config.ts";
import type { NotificationAdapter } from "../agent/notifications/types.ts";
import { createAppriseNotificationAdapter } from "../adapters/notifications/apprise.ts";
import { createBarkNotificationAdapter } from "../adapters/notifications/bark.ts";
import { createBlueBubblesNotificationAdapter } from "../adapters/notifications/bluebubbles.ts";
import { createDingtalkNotificationAdapter } from "../adapters/notifications/dingtalk.ts";
import { createDiscordNotificationAdapter } from "../adapters/notifications/discord.ts";
import { createFeishuWebhookNotificationAdapter } from "../adapters/notifications/feishu-webhook.ts";
import { createGoogleChatNotificationAdapter } from "../adapters/notifications/googlechat.ts";
import { createGotifyNotificationAdapter } from "../adapters/notifications/gotify.ts";
import { createIrcNotificationAdapter } from "../adapters/notifications/irc.ts";
import { createLineNotificationAdapter } from "../adapters/notifications/line.ts";
import { createMatrixNotificationAdapter } from "../adapters/notifications/matrix.ts";
import { createMattermostNotificationAdapter } from "../adapters/notifications/mattermost.ts";
import { createNextcloudTalkNotificationAdapter } from "../adapters/notifications/nextcloud-talk.ts";
import { createNtfyNotificationAdapter } from "../adapters/notifications/ntfy.ts";
import { createPushoverNotificationAdapter } from "../adapters/notifications/pushover.ts";
import { createSignalNotificationAdapter } from "../adapters/notifications/signal.ts";
import { createSmtpNotificationAdapter } from "../adapters/notifications/smtp.ts";
import { createSlackNotificationAdapter } from "../adapters/notifications/slack.ts";
import { createSynologyChatNotificationAdapter } from "../adapters/notifications/synology-chat.ts";
import { createTeamsNotificationAdapter } from "../adapters/notifications/teams.ts";
import { createTelegramNotificationAdapter } from "../adapters/notifications/telegram.ts";
import { createTwilioNotificationAdapter } from "../adapters/notifications/twilio.ts";
import { createTwitchNotificationAdapter } from "../adapters/notifications/twitch.ts";
import { createWebhookNotificationAdapter } from "../adapters/notifications/webhook.ts";
import { createWecomNotificationAdapter } from "../adapters/notifications/wecom.ts";
import { createWhatsAppNotificationAdapter } from "../adapters/notifications/whatsapp.ts";
import { createZaloNotificationAdapter } from "../adapters/notifications/zalo.ts";

/**
 * Adapters whose credentials come from `notification-config.json`, with environment variables as a
 * deployment fallback. A channel without its credential is not registered, so a target pointing at it
 * reports `adapter_missing` instead of failing every retry.
 */
export function createNotificationAdapters(
  env: NodeJS.ProcessEnv = process.env,
  config: NotificationChannelConfig = {}
): NotificationAdapter[] {
  const configured = (id: string, key: string): string | undefined =>
    config[id]?.[key]?.trim();
  const pick = (
    id: string,
    key: string,
    envValue: string | undefined
  ): string | undefined => configured(id, key) ?? envValue?.trim();
  const adapters: NotificationAdapter[] = [
    createWebhookNotificationAdapter(),
    createSlackNotificationAdapter(),
    createDiscordNotificationAdapter(),
    createTeamsNotificationAdapter(),
    createGoogleChatNotificationAdapter(),
    createMattermostNotificationAdapter(),
    createNtfyNotificationAdapter(),
    createBarkNotificationAdapter(),
    createFeishuWebhookNotificationAdapter({
      ...(pick("feishu-webhook", "url", env.THEBE_FEISHU_WEBHOOK_URL)
        ? {
            webhookUrl: pick(
              "feishu-webhook",
              "url",
              env.THEBE_FEISHU_WEBHOOK_URL
            ),
          }
        : {}),
      ...(pick("feishu-webhook", "secret", env.THEBE_FEISHU_WEBHOOK_SECRET)
        ? {
            secret: pick(
              "feishu-webhook",
              "secret",
              env.THEBE_FEISHU_WEBHOOK_SECRET
            ),
          }
        : {}),
    }),
    createGotifyNotificationAdapter({
      url: pick("gotify", "url", env.THEBE_GOTIFY_URL) || undefined,
    }),
    createSynologyChatNotificationAdapter(),
  ];

  const telegram = pick("telegram", "botToken", env.THEBE_TELEGRAM_BOT_TOKEN);
  if (telegram) {
    adapters.push(createTelegramNotificationAdapter({ botToken: telegram }));
  }

  const dingtalkUrl = pick("dingtalk", "url", env.THEBE_DINGTALK_WEBHOOK_URL);
  const dingtalkSecret = pick("dingtalk", "secret", env.THEBE_DINGTALK_SECRET);
  adapters.push(
    createDingtalkNotificationAdapter({
      ...(dingtalkUrl ? { webhookUrl: dingtalkUrl } : {}),
      ...(dingtalkSecret ? { secret: dingtalkSecret } : {}),
    })
  );

  const wecomUrl = pick("wecom", "url", env.THEBE_WECOM_WEBHOOK_URL);
  const corpId = pick("wecom", "corpId", env.THEBE_WECOM_CORP_ID);
  const corpSecret = pick("wecom", "corpSecret", env.THEBE_WECOM_CORP_SECRET);
  const agentId = pick("wecom", "agentId", env.THEBE_WECOM_AGENT_ID);
  adapters.push(
    createWecomNotificationAdapter({
      ...(wecomUrl ? { webhookUrl: wecomUrl } : {}),
      ...(corpId ? { corpId } : {}),
      ...(corpSecret ? { corpSecret } : {}),
      ...(agentId ? { agentId } : {}),
    })
  );

  const smtpUrl = pick("smtp", "url", env.THEBE_SMTP_URL);
  const smtpFrom = pick("smtp", "from", env.THEBE_SMTP_FROM);
  if (smtpUrl && smtpFrom) {
    adapters.push(
      createSmtpNotificationAdapter({ url: smtpUrl, from: smtpFrom })
    );
  }

  const pushoverToken = pick("pushover", "token", env.THEBE_PUSHOVER_TOKEN);
  if (pushoverToken) {
    adapters.push(createPushoverNotificationAdapter({ token: pushoverToken }));
  }

  const matrixHomeserver = pick(
    "matrix",
    "homeserverUrl",
    env.THEBE_MATRIX_HOMESERVER_URL
  );
  const matrixToken = pick(
    "matrix",
    "accessToken",
    env.THEBE_MATRIX_ACCESS_TOKEN
  );
  if (matrixHomeserver && matrixToken) {
    adapters.push(
      createMatrixNotificationAdapter({
        homeserverUrl: matrixHomeserver,
        accessToken: matrixToken,
      })
    );
  }

  const signalUrl = pick("signal", "url", env.THEBE_SIGNAL_URL);
  const signalNumber = pick("signal", "number", env.THEBE_SIGNAL_NUMBER);
  if (signalUrl && signalNumber) {
    adapters.push(
      createSignalNotificationAdapter({ url: signalUrl, number: signalNumber })
    );
  }

  const whatsappToken = pick(
    "whatsapp",
    "accessToken",
    env.THEBE_WHATSAPP_ACCESS_TOKEN
  );
  const whatsappPhoneId = pick(
    "whatsapp",
    "phoneNumberId",
    env.THEBE_WHATSAPP_PHONE_NUMBER_ID
  );
  if (whatsappToken && whatsappPhoneId) {
    adapters.push(
      createWhatsAppNotificationAdapter({
        accessToken: whatsappToken,
        phoneNumberId: whatsappPhoneId,
        ...(pick("whatsapp", "apiVersion", env.THEBE_WHATSAPP_API_VERSION)
          ? {
              apiVersion: pick(
                "whatsapp",
                "apiVersion",
                env.THEBE_WHATSAPP_API_VERSION
              )!,
            }
          : {}),
      })
    );
  }

  const twilioSid = pick("twilio", "accountSid", env.THEBE_TWILIO_ACCOUNT_SID);
  const twilioToken = pick("twilio", "authToken", env.THEBE_TWILIO_AUTH_TOKEN);
  const twilioFrom = pick("twilio", "from", env.THEBE_TWILIO_FROM);
  if (twilioSid && twilioToken && twilioFrom) {
    adapters.push(
      createTwilioNotificationAdapter({
        accountSid: twilioSid,
        authToken: twilioToken,
        from: twilioFrom,
      })
    );
  }

  const lineToken = pick(
    "line",
    "channelAccessToken",
    env.THEBE_LINE_CHANNEL_ACCESS_TOKEN
  );
  if (lineToken) {
    adapters.push(
      createLineNotificationAdapter({ channelAccessToken: lineToken })
    );
  }

  const zaloToken = pick("zalo", "token", env.THEBE_ZALO_BOT_TOKEN);
  if (zaloToken) {
    adapters.push(
      createZaloNotificationAdapter({
        token: zaloToken,
        ...(pick("zalo", "apiBaseUrl", env.THEBE_ZALO_API_URL)
          ? { apiBaseUrl: pick("zalo", "apiBaseUrl", env.THEBE_ZALO_API_URL)! }
          : {}),
      })
    );
  }

  const nextcloudUrl = pick(
    "nextcloud-talk",
    "url",
    env.THEBE_NEXTCLOUD_TALK_URL
  );
  const nextcloudSecret = pick(
    "nextcloud-talk",
    "botSecret",
    env.THEBE_NEXTCLOUD_TALK_BOT_SECRET
  );
  if (nextcloudUrl && nextcloudSecret) {
    adapters.push(
      createNextcloudTalkNotificationAdapter({
        url: nextcloudUrl,
        botSecret: nextcloudSecret,
      })
    );
  }

  const twitchClientId = pick("twitch", "clientId", env.THEBE_TWITCH_CLIENT_ID);
  const twitchToken = pick(
    "twitch",
    "userAccessToken",
    env.THEBE_TWITCH_USER_ACCESS_TOKEN
  );
  const twitchSenderId = pick("twitch", "senderId", env.THEBE_TWITCH_SENDER_ID);
  if (twitchClientId && twitchToken && twitchSenderId) {
    adapters.push(
      createTwitchNotificationAdapter({
        clientId: twitchClientId,
        userAccessToken: twitchToken,
        senderId: twitchSenderId,
      })
    );
  }

  const ircHost = pick("irc", "host", env.THEBE_IRC_HOST);
  const ircNick = pick("irc", "nick", env.THEBE_IRC_NICK);
  if (ircHost && ircNick) {
    const ircPortValue = pick("irc", "port", env.THEBE_IRC_PORT);
    const ircTlsValue = pick("irc", "tls", env.THEBE_IRC_TLS);
    const port = ircPort(ircPortValue, ircTlsValue);
    const ircPassword = pick("irc", "serverPassword", env.THEBE_IRC_PASSWORD);
    adapters.push(
      createIrcNotificationAdapter({
        host: ircHost,
        port,
        tls: ircTls(ircTlsValue, port),
        nick: ircNick,
        ...(ircPassword ? { password: ircPassword } : {}),
      })
    );
  }

  const blueBubblesUrl = pick("bluebubbles", "url", env.THEBE_BLUEBUBBLES_URL);
  const blueBubblesPassword = pick(
    "bluebubbles",
    "serverPassword",
    env.THEBE_BLUEBUBBLES_PASSWORD
  );
  if (blueBubblesUrl && blueBubblesPassword) {
    adapters.push(
      createBlueBubblesNotificationAdapter({
        url: blueBubblesUrl,
        password: blueBubblesPassword,
      })
    );
  }

  const appriseUrl = pick("apprise", "url", env.THEBE_APPRISE_URL);
  if (appriseUrl) {
    adapters.push(
      createAppriseNotificationAdapter({
        url: appriseUrl,
        ...(pick("apprise", "key", env.THEBE_APPRISE_KEY)
          ? { token: pick("apprise", "key", env.THEBE_APPRISE_KEY)! }
          : {}),
      })
    );
  }

  return adapters;
}

function ircPort(value: string | undefined, tls: string | undefined): number {
  const port = Number(value?.trim() || "");
  if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
  return ircTls(tls, 0) ? 6697 : 6667;
}

function ircTls(value: string | undefined, port: number): boolean {
  if (value !== undefined && value.trim() !== "") {
    return /^(?:1|true|yes|on)$/i.test(value.trim());
  }
  return port === 0 || port === 6697;
}
