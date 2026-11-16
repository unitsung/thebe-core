import type { SlashHost } from "./context.ts";
import { attachPromptInput, attachSelectList } from "../overlays/index.ts";
import { getThebeConfigDir } from "../settings/config.ts";
import {
  NOTIFICATION_CHANNEL_CONFIG_GROUPS,
  createNotificationChannelConfigStore,
  type NotificationChannelConfig,
  type NotificationChannelConfigField,
  type NotificationChannelConfigGroup,
} from "../../../agent/notifications/channel-config.ts";

/**
 * `/notifications` edits the owner-only channel credential file. It never prints a secret; the
 * prompt masks typed characters and Enter keeps an existing value. Core loads the file at startup,
 * so a save takes effect after a restart.
 */
export async function handleNotificationsCommand(
  host: SlashHost,
  arg: string
): Promise<boolean> {
  const store = createNotificationChannelConfigStore({
    dir: getThebeConfigDir(),
  });
  const config = await store.get();
  const action = arg.trim();

  if (action === "path") {
    host.notice(store.path);
    return true;
  }
  if (action === "list") {
    host.notice(formatConfigList(config, store.path));
    return true;
  }
  if (action) {
    const group = NOTIFICATION_CHANNEL_CONFIG_GROUPS.find(
      (candidate) => candidate.id === action
    );
    if (!group) {
      host.notice(
        `unknown channel "${action}"; use /notifications to choose one`
      );
      return true;
    }
    await editGroup(host, store, config, group);
    return true;
  }

  const selected = await attachSelectList(
    host.tui,
    NOTIFICATION_CHANNEL_CONFIG_GROUPS.map((group) => ({
      label: `${configuredFields(config, group).length > 0 ? "★ " : "  "}${group.label} — ${configSummary(config, group)}`,
      value: group.id,
    })),
    host.editor,
    undefined,
    host.getActiveSelectListTheme()
  );
  if (!selected) return true;
  const group = NOTIFICATION_CHANNEL_CONFIG_GROUPS.find(
    (candidate) => candidate.id === selected.value
  );
  if (group) await editGroup(host, store, config, group);
  return true;
}

async function editGroup(
  host: SlashHost,
  store: ReturnType<typeof createNotificationChannelConfigStore>,
  config: NotificationChannelConfig,
  group: NotificationChannelConfigGroup
): Promise<void> {
  const values = { ...config[group.id] };
  for (const field of group.fields) {
    const current = values[field.key] ?? "";
    const answer = await attachPromptInput(host.tui, {
      prompt: `${field.label}: `,
      placeholder: current
        ? field.secret
          ? "configured (Enter keeps, - clears)"
          : `${current} (Enter keeps, - clears)`
        : (field.placeholder ?? "not set"),
      focusBack: host.editor,
      secret: field.secret,
    });
    if (answer === null) {
      host.notice("notification configuration unchanged");
      return;
    }
    const text = answer.trim();
    if (!text) continue;
    if (text === "-") {
      delete values[field.key];
      continue;
    }
    const invalid = validateField(field, text);
    if (invalid) {
      host.notice(`${field.label}: ${invalid}; nothing was saved`);
      return;
    }
    values[field.key] = text;
  }
  const next = { ...config };
  if (Object.keys(values).length > 0) next[group.id] = values;
  else delete next[group.id];
  try {
    await store.set(next);
    host.notice(
      `saved ${group.label} to ${store.path}\nA running Core reloads the channel automatically.`
    );
  } catch (error) {
    host.notice(
      `notification configuration was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function validateField(
  field: NotificationChannelConfigField,
  value: string
): string | undefined {
  if (value.length > 4_096) return "value is too long";
  if (field.kind === "url") {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "use an http(s) URL";
      }
    } catch {
      return "use an http(s) URL";
    }
  }
  if (field.kind === "smtp") {
    try {
      const url = new URL(value);
      if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
        return "use an smtp:// or smtps:// URL";
      }
    } catch {
      return "use an smtp:// or smtps:// URL";
    }
  }
  if (field.kind === "number") {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return "use an integer between 1 and 65535";
    }
  }
  if (
    field.kind === "boolean" &&
    !/^(?:true|false|1|0|yes|no|on|off)$/i.test(value)
  ) {
    return "use true or false";
  }
  return undefined;
}

function formatConfigList(
  config: NotificationChannelConfig,
  path: string
): string {
  const lines = [`Notification channel config: ${path}`, ""];
  for (const group of NOTIFICATION_CHANNEL_CONFIG_GROUPS) {
    const fields = configuredFields(config, group);
    lines.push(
      `${group.label}: ${
        fields.length > 0
          ? fields
              .map(
                (field) =>
                  `${field.label}=${field.secret ? "••••••" : config[group.id]?.[field.key]}`
              )
              .join(", ")
          : "not configured"
      }`
    );
  }
  lines.push("", "Edit with /notifications; secrets are never printed.");
  return lines.join("\n");
}

function configSummary(
  config: NotificationChannelConfig,
  group: NotificationChannelConfigGroup
): string {
  const fields = configuredFields(config, group);
  return fields.length === 0
    ? "not configured"
    : `${fields.length}/${group.fields.length} set`;
}

function configuredFields(
  config: NotificationChannelConfig,
  group: NotificationChannelConfigGroup
): NotificationChannelConfigField[] {
  return group.fields.filter((field) => Boolean(config[group.id]?.[field.key]));
}
