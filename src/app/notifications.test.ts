import { describe, expect, it } from "vitest";
import { notificationChannels } from "../agent/notifications/channels.ts";
import { createNotificationAdapters } from "./notifications.ts";

const ALL_ENV = {
  THEBE_TELEGRAM_BOT_TOKEN: "testTelegramToken",
  THEBE_DINGTALK_WEBHOOK_URL: "https://example.test/dingtalk",
  THEBE_WECOM_WEBHOOK_URL: "https://example.test/wecom",
  THEBE_SMTP_URL: "smtp://127.0.0.1:2525",
  THEBE_SMTP_FROM: "ops@example.test",
  THEBE_PUSHOVER_TOKEN: "testPushoverToken",
  THEBE_MATRIX_HOMESERVER_URL: "https://matrix.example.test",
  THEBE_MATRIX_ACCESS_TOKEN: "testMatrixToken",
  THEBE_SIGNAL_URL: "http://127.0.0.1:8080",
  THEBE_SIGNAL_NUMBER: "15550104",
  THEBE_WHATSAPP_ACCESS_TOKEN: "testWhatsAppToken",
  THEBE_WHATSAPP_PHONE_NUMBER_ID: "123456789",
  THEBE_TWILIO_ACCOUNT_SID: "AC123",
  THEBE_TWILIO_AUTH_TOKEN: "testTwilioToken",
  THEBE_TWILIO_FROM: "15550104",
  THEBE_BLUEBUBBLES_URL: "http://127.0.0.1:1234",
  THEBE_BLUEBUBBLES_PASSWORD: "zzz998877",
  THEBE_APPRISE_URL: "http://127.0.0.1:8000",
  THEBE_APPRISE_KEY: "testAppriseKey",
  THEBE_LINE_CHANNEL_ACCESS_TOKEN: "testLineToken",
  THEBE_ZALO_BOT_TOKEN: "testZaloToken",
  THEBE_NEXTCLOUD_TALK_URL: "https://cloud.example.test",
  THEBE_NEXTCLOUD_TALK_BOT_SECRET: "testNextcloudBotSecret",
  THEBE_TWITCH_CLIENT_ID: "testTwitchClientId",
  THEBE_TWITCH_USER_ACCESS_TOKEN: "testTwitchToken",
  THEBE_TWITCH_SENDER_ID: "141981764",
  THEBE_IRC_HOST: "irc.example.test",
  THEBE_IRC_PORT: "6697",
  THEBE_IRC_NICK: "thebe",
};

const CONFIG_ONLY = {
  telegram: { botToken: "config-telegram-token" },
  smtp: { url: "smtp://127.0.0.1:2525", from: "ops@example.test" },
  pushover: { token: "config-pushover-token" },
  matrix: {
    homeserverUrl: "https://matrix.example.test",
    accessToken: "config-matrix-token",
  },
  signal: { url: "http://127.0.0.1:8080", number: "15550104" },
  whatsapp: {
    accessToken: "config-whatsapp-token",
    phoneNumberId: "123456789",
    apiVersion: "v20.0",
  },
  line: { channelAccessToken: "config-line-token" },
  zalo: { token: "config-zalo-token" },
  "nextcloud-talk": {
    url: "https://cloud.example.test",
    botSecret: "config-nextcloud-secret",
  },
  twilio: {
    accountSid: "AC123",
    authToken: "config-twilio-token",
    from: "15550104",
  },
  bluebubbles: {
    url: "http://127.0.0.1:1234",
    serverPassword: "config-bluebubbles-secret",
  },
  twitch: {
    clientId: "config-twitch-client",
    userAccessToken: "config-twitch-token",
    senderId: "141981764",
  },
  irc: { host: "irc.example.test", port: "6697", tls: "true", nick: "thebe" },
  apprise: { url: "http://127.0.0.1:8000", key: "config-apprise-key" },
  "feishu-webhook": { url: "https://example.test/feishu" },
  dingtalk: { url: "https://example.test/dingtalk" },
  wecom: { url: "https://example.test/wecom" },
  gotify: { url: "https://gotify.example.test" },
};

describe("notification adapter catalog", () => {
  it("lists every adapter the host can register", () => {
    const adapters = createNotificationAdapters(ALL_ENV);
    const catalog = notificationChannels(adapters);
    expect(new Set(catalog.map((entry) => entry.id)).size).toBe(catalog.length);
    expect(catalog).toHaveLength(adapters.length);
    for (const adapter of adapters) {
      expect(catalog.some((entry) => entry.id === adapter.id)).toBe(true);
    }
    expect(catalog.every((entry) => entry.available)).toBe(true);
  });

  it("registers host-credentialed adapters from the config file", () => {
    const adapters = createNotificationAdapters({}, CONFIG_ONLY);
    const catalog = notificationChannels(adapters);
    expect(catalog.every((entry) => entry.available)).toBe(true);
    expect(catalog).toHaveLength(27);
  });

  it("registers webhook-address adapters without host credentials", () => {
    const adapters = createNotificationAdapters({});
    const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    for (const id of [
      "dingtalk",
      "wecom",
      "gotify",
      "mattermost",
      "synology-chat",
      "feishu-webhook",
      "ntfy",
      "bark",
    ]) {
      expect(byId.has(id)).toBe(true);
    }
    expect(
      byId.get("dingtalk")!.accepts({
        source: "dingtalk",
        thread: "t",
        address: { url: "https://example.test/dingtalk" },
      })
    ).toBe(true);
    expect(
      byId.get("wecom")!.accepts({
        source: "wecom",
        thread: "t",
        address: { url: "https://example.test/wecom" },
      })
    ).toBe(true);
    expect(
      byId.get("gotify")!.accepts({
        source: "gotify",
        thread: "t",
        address: {
          url: "https://gotify.example.test",
          token: "app-token",
        },
      })
    ).toBe(true);
  });
});
