import type { NotificationAdapter, NotificationCapabilities } from "./types.ts";

export type NotificationAddressFieldKind = "text" | "url" | "phone" | "list";

/** One input the App renders when adding a target for a channel. */
export type NotificationAddressField = {
  key: string;
  label: string;
  required: boolean;
  kind: NotificationAddressFieldKind;
  secret?: boolean;
  placeholder?: string;
};

/**
 * What a client needs to configure a channel without hard-coding adapter knowledge. The catalog is
 * complete even when a host-credentialed adapter is absent, so the App can explain what is missing.
 */
export type NotificationChannelInfo = {
  id: string;
  label: string;
  description: string;
  addressFields: NotificationAddressField[];
  /** The host has the credentials this adapter needs, so a target can deliver now. */
  available: boolean;
  /** Host configuration that turns the adapter on, when it is absent. */
  setup?: string;
  capabilities?: NotificationCapabilities;
};

type CatalogEntry = Omit<NotificationChannelInfo, "available" | "capabilities">;

const CATALOG: readonly CatalogEntry[] = [
  {
    id: "webhook",
    label: "Webhook",
    description: "POST a JSON notice to any HTTP endpoint.",
    addressFields: [
      { key: "url", label: "URL", required: true, kind: "url" },
      {
        key: "secret",
        label: "Signing secret",
        required: false,
        kind: "text",
        secret: true,
      },
    ],
  },
  {
    id: "im",
    label: "Two-way IM",
    description:
      "A bound Telegram, Weixin, QQ or iMessage chat. A proactive channel sends directly; a reply-only channel can carry a notice only within its latest inbound reply window.",
    addressFields: [
      {
        key: "accountId",
        label: "IM channel id",
        required: true,
        kind: "text",
      },
      {
        key: "chatKind",
        label: "Chat kind",
        required: true,
        kind: "text",
        placeholder: "direct",
      },
      { key: "chatId", label: "Chat id", required: true, kind: "text" },
      {
        key: "threadId",
        label: "Thread id",
        required: false,
        kind: "text",
      },
    ],
    setup:
      "Add and bind an IM channel in Settings → Channels. QQ and Weixin are reply-only; without a recent inbound message a notice is dropped as window_closed.",
  },
  {
    id: "slack",
    label: "Slack",
    description: "Slack incoming webhook.",
    addressFields: [
      { key: "url", label: "Webhook URL", required: true, kind: "url" },
    ],
  },
  {
    id: "discord",
    label: "Discord",
    description: "Discord channel webhook.",
    addressFields: [
      { key: "url", label: "Webhook URL", required: true, kind: "url" },
    ],
  },
  {
    id: "telegram",
    label: "Telegram",
    description: "A chat through the Telegram Bot API.",
    addressFields: [
      {
        key: "chatId",
        label: "Chat id or @username",
        required: true,
        kind: "text",
        placeholder: "123456789",
      },
      { key: "threadId", label: "Topic id", required: false, kind: "text" },
    ],
    setup:
      "Run /notifications telegram in the TUI, or set THEBE_TELEGRAM_BOT_TOKEN.",
  },
  {
    id: "teams",
    label: "Microsoft Teams",
    description: "A Teams incoming webhook.",
    addressFields: [
      { key: "url", label: "Webhook URL", required: true, kind: "url" },
    ],
  },
  {
    id: "googlechat",
    label: "Google Chat",
    description: "A Google Chat space webhook.",
    addressFields: [
      { key: "url", label: "Webhook URL", required: true, kind: "url" },
    ],
  },
  {
    id: "mattermost",
    label: "Mattermost",
    description: "A Mattermost incoming webhook.",
    addressFields: [
      { key: "url", label: "Webhook URL", required: true, kind: "url" },
      {
        key: "channel",
        label: "Channel override",
        required: false,
        kind: "text",
      },
    ],
  },
  {
    id: "ntfy",
    label: "ntfy",
    description: "Public ntfy.sh or a self-hosted ntfy server.",
    addressFields: [
      {
        key: "url",
        label: "Server or topic URL",
        required: false,
        kind: "url",
        placeholder: "https://ntfy.sh",
      },
      { key: "topic", label: "Topic", required: false, kind: "text" },
      {
        key: "token",
        label: "Access token",
        required: false,
        kind: "text",
        secret: true,
      },
    ],
  },
  {
    id: "bark",
    label: "Bark",
    description: "Bark push on iPhone.",
    addressFields: [
      {
        key: "deviceKey",
        label: "Device key",
        required: true,
        kind: "text",
        secret: true,
      },
      {
        key: "server",
        label: "Server",
        required: false,
        kind: "url",
        placeholder: "https://api.day.app",
      },
    ],
  },
  {
    id: "feishu-webhook",
    label: "Feishu bot",
    description: "A Feishu custom-bot webhook.",
    addressFields: [
      { key: "url", label: "Webhook URL", required: false, kind: "url" },
      {
        key: "secret",
        label: "Signing secret",
        required: false,
        kind: "text",
        secret: true,
      },
    ],
    setup:
      "Run /notifications feishu-webhook in the TUI, enter a URL here, or set THEBE_FEISHU_WEBHOOK_URL.",
  },
  {
    id: "dingtalk",
    label: "DingTalk",
    description: "A DingTalk custom robot.",
    addressFields: [
      { key: "url", label: "Webhook URL", required: false, kind: "url" },
      {
        key: "accessToken",
        label: "Access token",
        required: false,
        kind: "text",
        secret: true,
      },
      {
        key: "secret",
        label: "Signing secret",
        required: false,
        kind: "text",
        secret: true,
      },
    ],
    setup:
      "Run /notifications dingtalk in the TUI, enter a URL here, or set THEBE_DINGTALK_WEBHOOK_URL.",
  },
  {
    id: "wecom",
    label: "WeCom",
    description: "A WeCom group robot or application message.",
    addressFields: [
      { key: "url", label: "Robot webhook URL", required: false, kind: "url" },
      {
        key: "toUser",
        label: "Application recipient",
        required: false,
        kind: "text",
      },
    ],
    setup:
      "Run /notifications wecom in the TUI, enter a robot webhook URL in the target, or set THEBE_WECOM_WEBHOOK_URL; application messages also need the corp id, secret and agent id.",
  },
  {
    id: "smtp",
    label: "Email",
    description: "SMTP delivery through the Core host.",
    addressFields: [
      {
        key: "to",
        label: "Recipients",
        required: true,
        kind: "list",
        placeholder: "you@example.com, ops@example.com",
      },
    ],
    setup:
      "Run /notifications smtp in the TUI, or set THEBE_SMTP_URL and THEBE_SMTP_FROM.",
  },
  {
    id: "pushover",
    label: "Pushover",
    description: "Pushover push on phone and desktop.",
    addressFields: [
      {
        key: "user",
        label: "User or group key",
        required: true,
        kind: "text",
        secret: true,
      },
    ],
    setup:
      "Run /notifications pushover in the TUI, or set THEBE_PUSHOVER_TOKEN.",
  },
  {
    id: "gotify",
    label: "Gotify",
    description: "A self-hosted Gotify server.",
    addressFields: [
      {
        key: "token",
        label: "Application token",
        required: true,
        kind: "text",
        secret: true,
      },
      {
        key: "url",
        label: "Server URL",
        required: false,
        kind: "url",
        placeholder: "https://gotify.example.com",
      },
    ],
    setup:
      "Run /notifications gotify in the TUI, enter a server URL in the target, or set THEBE_GOTIFY_URL.",
  },
  {
    id: "matrix",
    label: "Matrix",
    description: "A Matrix room.",
    addressFields: [
      {
        key: "roomId",
        label: "Room id or alias",
        required: true,
        kind: "text",
        placeholder: "!ops:matrix.example",
      },
    ],
    setup:
      "Run /notifications matrix in the TUI, or set THEBE_MATRIX_HOMESERVER_URL and THEBE_MATRIX_ACCESS_TOKEN.",
  },
  {
    id: "nextcloud-talk",
    label: "Nextcloud Talk",
    description: "A Nextcloud Talk room through a response bot.",
    addressFields: [
      {
        key: "roomToken",
        label: "Room token",
        required: true,
        kind: "text",
        placeholder: "abc123",
      },
    ],
    setup:
      "Run /notifications nextcloud-talk in the TUI, or set THEBE_NEXTCLOUD_TALK_URL and THEBE_NEXTCLOUD_TALK_BOT_SECRET; install the bot with the response feature.",
  },
  {
    id: "signal",
    label: "Signal",
    description: "Signal through signal-cli-rest-api.",
    addressFields: [
      {
        key: "recipients",
        label: "Recipients",
        required: true,
        kind: "list",
        placeholder: "15550103, group.abc123",
      },
    ],
    setup:
      "Run /notifications signal in the TUI, or set THEBE_SIGNAL_URL and THEBE_SIGNAL_NUMBER.",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    description: "WhatsApp Cloud API text messages.",
    addressFields: [
      {
        key: "to",
        label: "Recipient",
        required: true,
        kind: "phone",
        placeholder: "15550103",
      },
    ],
    setup:
      "Run /notifications whatsapp in the TUI, or set THEBE_WHATSAPP_ACCESS_TOKEN and THEBE_WHATSAPP_PHONE_NUMBER_ID.",
  },
  {
    id: "line",
    label: "LINE",
    description: "A LINE user, group, or room through the Messaging API.",
    addressFields: [
      {
        key: "to",
        label: "Recipient id",
        required: true,
        kind: "text",
        placeholder: "U1234567890abcdef",
      },
    ],
    setup:
      "Run /notifications line in the TUI, or set THEBE_LINE_CHANNEL_ACCESS_TOKEN.",
  },
  {
    id: "zalo",
    label: "Zalo Bot",
    description: "A Zalo Bot chat through the official Bot API.",
    addressFields: [
      {
        key: "chatId",
        label: "Chat id",
        required: true,
        kind: "text",
      },
    ],
    setup: "Run /notifications zalo in the TUI, or set THEBE_ZALO_BOT_TOKEN.",
  },
  {
    id: "twilio",
    label: "SMS (Twilio)",
    description: "SMS through Twilio.",
    addressFields: [
      {
        key: "to",
        label: "Recipient",
        required: true,
        kind: "phone",
        placeholder: "15550103",
      },
    ],
    setup:
      "Run /notifications twilio in the TUI, or set THEBE_TWILIO_ACCOUNT_SID, THEBE_TWILIO_AUTH_TOKEN and THEBE_TWILIO_FROM.",
  },
  {
    id: "bluebubbles",
    label: "iMessage (BlueBubbles)",
    description: "iMessage through a BlueBubbles server.",
    addressFields: [
      {
        key: "chatGuid",
        label: "Chat GUID",
        required: true,
        kind: "text",
        placeholder: "iMessage;-;15550103",
      },
    ],
    setup:
      "Run /notifications bluebubbles in the TUI, or set THEBE_BLUEBUBBLES_URL and THEBE_BLUEBUBBLES_PASSWORD.",
  },
  {
    id: "synology-chat",
    label: "Synology Chat",
    description: "A Synology Chat incoming webhook.",
    addressFields: [
      { key: "url", label: "Webhook URL", required: true, kind: "url" },
    ],
  },
  {
    id: "twitch",
    label: "Twitch",
    description: "A Twitch channel chat through the Helix API.",
    addressFields: [
      {
        key: "broadcasterId",
        label: "Broadcaster id",
        required: true,
        kind: "text",
      },
    ],
    setup:
      "Run /notifications twitch in the TUI, or set THEBE_TWITCH_CLIENT_ID, THEBE_TWITCH_USER_ACCESS_TOKEN and THEBE_TWITCH_SENDER_ID.",
  },
  {
    id: "irc",
    label: "IRC",
    description: "A channel on an IRC server.",
    addressFields: [
      {
        key: "channel",
        label: "Channel",
        required: true,
        kind: "text",
        placeholder: "#ops",
      },
    ],
    setup:
      "Run /notifications irc in the TUI, or set THEBE_IRC_HOST and THEBE_IRC_NICK.",
  },
  {
    id: "apprise",
    label: "Apprise",
    description: "An Apprise API server's saved configuration.",
    addressFields: [
      {
        key: "token",
        label: "Configuration key",
        required: false,
        kind: "text",
        secret: true,
      },
    ],
    setup: "Run /notifications apprise in the TUI, or set THEBE_APPRISE_URL.",
  },
];

/** Every catalog entry, annotated with whether the running host registered its adapter. */
export function notificationChannels(
  adapters: readonly NotificationAdapter[]
): NotificationChannelInfo[] {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  return CATALOG.map((entry) => {
    const adapter = byId.get(entry.id);
    return {
      ...entry,
      available: adapter !== undefined,
      ...(adapter?.capabilities ? { capabilities: adapter.capabilities } : {}),
    };
  });
}
