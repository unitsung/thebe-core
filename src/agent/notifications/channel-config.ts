import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";

export type NotificationChannelConfigField = {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  kind?: "text" | "url" | "smtp" | "number" | "boolean";
};

export type NotificationChannelConfigGroup = {
  id: string;
  label: string;
  fields: NotificationChannelConfigField[];
};

/**
 * Host-level credentials for adapters whose address is only a destination. A target's own address
 * still wins for address-scoped services such as webhooks; this file holds the shared bot, server or
 * account credential once instead of repeating it on every target.
 */
export const NOTIFICATION_CHANNEL_CONFIG_GROUPS: readonly NotificationChannelConfigGroup[] =
  [
    {
      id: "telegram",
      label: "Telegram",
      fields: [
        {
          key: "botToken",
          label: "Bot token",
          secret: true,
          placeholder: "123456:ABC…",
        },
      ],
    },
    {
      id: "smtp",
      label: "Email (SMTP)",
      fields: [
        {
          key: "url",
          label: "SMTP URL",
          kind: "smtp",
          secret: true,
          placeholder: "smtps://user:...@smtp.example.com:465",
        },
        {
          key: "from",
          label: "From address",
          placeholder: "thebe@example.com",
        },
      ],
    },
    {
      id: "pushover",
      label: "Pushover",
      fields: [
        {
          key: "token",
          label: "Application token",
          secret: true,
        },
      ],
    },
    {
      id: "matrix",
      label: "Matrix",
      fields: [
        {
          key: "homeserverUrl",
          label: "Homeserver URL",
          kind: "url",
          placeholder: "https://matrix.example.com",
        },
        {
          key: "accessToken",
          label: "Access token",
          secret: true,
        },
      ],
    },
    {
      id: "signal",
      label: "Signal",
      fields: [
        {
          key: "url",
          label: "signal-cli REST URL",
          kind: "url",
          placeholder: "http://127.0.0.1:8080",
        },
        { key: "number", label: "Sender number" },
      ],
    },
    {
      id: "whatsapp",
      label: "WhatsApp Cloud",
      fields: [
        { key: "accessToken", label: "Access token", secret: true },
        { key: "phoneNumberId", label: "Phone number id" },
        {
          key: "apiVersion",
          label: "Graph API version",
          placeholder: "v20.0",
        },
      ],
    },
    {
      id: "line",
      label: "LINE",
      fields: [
        {
          key: "channelAccessToken",
          label: "Channel access token",
          secret: true,
        },
      ],
    },
    {
      id: "zalo",
      label: "Zalo Bot",
      fields: [
        { key: "token", label: "Bot token", secret: true },
        {
          key: "apiBaseUrl",
          label: "API base URL",
          kind: "url",
          placeholder: "https://bot-api.zaloplatforms.com",
        },
      ],
    },
    {
      id: "nextcloud-talk",
      label: "Nextcloud Talk",
      fields: [
        {
          key: "url",
          label: "Nextcloud URL",
          kind: "url",
          placeholder: "https://cloud.example.com",
        },
        { key: "botSecret", label: "Bot secret", secret: true },
      ],
    },
    {
      id: "twilio",
      label: "SMS (Twilio)",
      fields: [
        { key: "accountSid", label: "Account SID", secret: true },
        { key: "authToken", label: "Auth token", secret: true },
        { key: "from", label: "From number" },
      ],
    },
    {
      id: "bluebubbles",
      label: "iMessage (BlueBubbles)",
      fields: [
        {
          key: "url",
          label: "BlueBubbles URL",
          kind: "url",
          placeholder: "http://127.0.0.1:1234",
        },
        { key: "serverPassword", label: "Server secret", secret: true },
      ],
    },
    {
      id: "twitch",
      label: "Twitch",
      fields: [
        { key: "clientId", label: "Client id" },
        {
          key: "userAccessToken",
          label: "User access token",
          secret: true,
        },
        { key: "senderId", label: "Sender user id" },
      ],
    },
    {
      id: "irc",
      label: "IRC",
      fields: [
        { key: "host", label: "Server host", placeholder: "irc.example.com" },
        { key: "port", label: "Port", kind: "number", placeholder: "6697" },
        { key: "tls", label: "TLS (true/false)", kind: "boolean" },
        { key: "nick", label: "Nickname", placeholder: "thebe" },
        { key: "serverPassword", label: "Server secret", secret: true },
      ],
    },
    {
      id: "apprise",
      label: "Apprise",
      fields: [
        {
          key: "url",
          label: "Apprise API URL",
          kind: "url",
          placeholder: "http://127.0.0.1:8000",
        },
        { key: "key", label: "Configuration key", secret: true },
      ],
    },
    {
      id: "feishu-webhook",
      label: "Feishu bot defaults",
      fields: [
        { key: "url", label: "Webhook URL", kind: "url", secret: true },
        { key: "secret", label: "Signing secret", secret: true },
      ],
    },
    {
      id: "dingtalk",
      label: "DingTalk defaults",
      fields: [
        { key: "url", label: "Webhook URL", kind: "url", secret: true },
        { key: "secret", label: "Signing secret", secret: true },
      ],
    },
    {
      id: "wecom",
      label: "WeCom defaults",
      fields: [
        { key: "url", label: "Group robot URL", kind: "url", secret: true },
        { key: "corpId", label: "Corp id" },
        { key: "corpSecret", label: "Corp secret", secret: true },
        { key: "agentId", label: "Agent id" },
      ],
    },
    {
      id: "gotify",
      label: "Gotify defaults",
      fields: [
        {
          key: "url",
          label: "Server URL",
          kind: "url",
          placeholder: "https://gotify.example.com",
        },
      ],
    },
  ];

export type NotificationChannelConfig = Record<string, Record<string, string>>;

const MAX_VALUE = 4_096;
export const notificationChannelConfigFileName = "notification-config.json";
export const NOTIFICATION_CONFIG_REDACTED = "***REDACTED***";

export class NotificationChannelConfigError extends Error {}

export function notificationChannelConfigPath(dir: string): string {
  return join(dir, notificationChannelConfigFileName);
}

/** The view an HTTP client receives: secret values are replaced, not omitted. */
export function redactNotificationChannelConfig(
  config: NotificationChannelConfig
): NotificationChannelConfig {
  const view: NotificationChannelConfig = {};
  for (const group of NOTIFICATION_CHANNEL_CONFIG_GROUPS) {
    const values = config[group.id];
    if (!values) continue;
    const fields: Record<string, string> = {};
    for (const field of group.fields) {
      const value = values[field.key];
      if (value === undefined) continue;
      fields[field.key] = field.secret ? NOTIFICATION_CONFIG_REDACTED : value;
    }
    if (Object.keys(fields).length > 0) view[group.id] = fields;
  }
  return view;
}

/**
 * Restores masked values from the current config before a PUT. A field that is present and empty
 * clears the credential; a missing field also clears it because the PUT carries the complete config.
 */
export function restoreNotificationChannelConfigSecrets(
  value: unknown,
  current: NotificationChannelConfig
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = structuredClone(value) as Record<string, unknown>;
  for (const group of NOTIFICATION_CHANNEL_CONFIG_GROUPS) {
    const raw = copy[group.id];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const incoming = raw as Record<string, unknown>;
    for (const field of group.fields) {
      if (!field.secret) continue;
      if (incoming[field.key] === NOTIFICATION_CONFIG_REDACTED) {
        const saved = current[group.id]?.[field.key];
        if (saved === undefined) delete incoming[field.key];
        else incoming[field.key] = saved;
      }
    }
  }
  return copy;
}

/** Reads the owner-only channel configuration; a missing file is an empty configuration. */
export async function loadNotificationChannelConfig(
  dir: string
): Promise<NotificationChannelConfig> {
  const path = notificationChannelConfigPath(dir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new NotificationChannelConfigError(
      `Could not read ${path}: ${message(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NotificationChannelConfigError(
      `${path} is not valid JSON; fix or remove it before starting Core`
    );
  }
  return parseNotificationChannelConfig(parsed);
}

/** Writes the channel configuration atomically with owner-only permissions. */
export function createNotificationChannelConfigStore(options: {
  dir: string;
}): {
  path: string;
  get: () => Promise<NotificationChannelConfig>;
  set: (value: unknown) => Promise<NotificationChannelConfig>;
} {
  const path = notificationChannelConfigPath(options.dir);
  return {
    path,
    get: () => loadNotificationChannelConfig(options.dir),
    async set(value) {
      const config = parseNotificationChannelConfig(value);
      await mkdir(options.dir, { recursive: true });
      await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return config;
    },
  };
}

export function parseNotificationChannelConfig(
  value: unknown
): NotificationChannelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationChannelConfigError(
      "channel configuration must be an object"
    );
  }
  const config: NotificationChannelConfig = {};
  for (const group of NOTIFICATION_CHANNEL_CONFIG_GROUPS) {
    const rawGroup = (value as Record<string, unknown>)[group.id];
    if (rawGroup === undefined) continue;
    if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) {
      throw new NotificationChannelConfigError(`${group.id} must be an object`);
    }
    const fields: Record<string, string> = {};
    for (const field of group.fields) {
      const raw = (rawGroup as Record<string, unknown>)[field.key];
      if (raw === undefined || raw === null || raw === "") continue;
      if (typeof raw !== "string") {
        throw new NotificationChannelConfigError(
          `${group.id}.${field.key} must be a string`
        );
      }
      const text = raw.trim();
      if (!text) continue;
      if (text.length > MAX_VALUE) {
        throw new NotificationChannelConfigError(
          `${group.id}.${field.key} must be at most ${MAX_VALUE} characters`
        );
      }
      fields[field.key] = text;
    }
    if (Object.keys(fields).length > 0) config[group.id] = fields;
  }
  return config;
}

export function configuredNotificationChannels(
  config: NotificationChannelConfig
): string[] {
  return NOTIFICATION_CHANNEL_CONFIG_GROUPS.filter(
    (group) => Object.keys(config[group.id] ?? {}).length > 0
  ).map((group) => group.id);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
