import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { parseQuietHours, type QuietHours } from "./quiet-hours.ts";
import type { ChannelRef } from "../sources/types.ts";
import {
  isNoticeCategory,
  isNoticePriority,
  NOTICE_CATEGORIES,
  NOTICE_PRIORITIES,
  type NoticeCategory,
  type NoticePriority,
  type Notification,
  type NotificationSettings,
  type NotificationTarget,
} from "./types.ts";

const SETTINGS_FILE = "notifications.json";
const MAX_TARGETS = 50;
const MAX_ID_LENGTH = 200;
const MAX_LABEL_LENGTH = 100;
const MAX_TEXT_LENGTH = 4096;
const MAX_DEEP_LINK_LENGTH = 2048;
const MAX_ADDRESS_KEYS = 20;
const MAX_ADDRESS_VALUE_LENGTH = 2048;
const DEFAULT_RATE_LIMIT_PER_HOUR = 60;

export class NotificationInputError extends Error {}

export type NotificationSettingsStore = {
  get(): Promise<NotificationSettings>;
  set(value: unknown): Promise<NotificationSettings>;
};

/** Defaults for a Core that has never configured a notification target. */
export function defaultNotificationSettings(now: Date): NotificationSettings {
  return {
    version: 1,
    targets: [],
    criticalBypassesQuietHours: true,
    rateLimitPerHour: DEFAULT_RATE_LIMIT_PER_HOUR,
    updatedAt: now.toISOString(),
  };
}

/** A durable settings file at `notifications.json`; owner-only because addresses may contain a webhook URL. */
export function createNotificationSettingsStore(options: {
  dir?: string;
  now?: () => Date;
}): NotificationSettingsStore {
  const now = options.now ?? (() => new Date());
  const file = options.dir ? join(options.dir, SETTINGS_FILE) : undefined;
  let cached: NotificationSettings | undefined;
  let loading: Promise<NotificationSettings> | undefined;

  async function load(): Promise<NotificationSettings> {
    if (cached) return cached;
    if (!file) {
      cached = defaultNotificationSettings(now());
      return cached;
    }
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
      const parsed = parseNotificationSettings(raw, now());
      // A read keeps the time of the last write, not the moment this process loaded it.
      const stored =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).updatedAt
          : undefined;
      if (typeof stored === "string" && Number.isFinite(Date.parse(stored))) {
        parsed.updatedAt = stored;
      }
      cached = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        cached = defaultNotificationSettings(now());
        return cached;
      }
      // A corrupt settings file must not silently erase targets: surface it instead of pretending the
      // person never configured notifications.
      throw error;
    }
    return cached;
  }

  async function persist(settings: NotificationSettings): Promise<void> {
    if (!file || !options.dir) return;
    await mkdir(options.dir, { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(settings)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return {
    async get() {
      loading ??= load();
      return loading;
    },
    async set(value) {
      const settings = parseNotificationSettings(value, now());
      cached = settings;
      loading = Promise.resolve(settings);
      await persist(settings);
      return settings;
    },
  };
}

/** Validates a complete settings body. Missing collections default to empty rather than rejecting. */
export function parseNotificationSettings(
  value: unknown,
  now: Date
): NotificationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationInputError("settings must be an object");
  }
  const row = value as Record<string, unknown>;
  if (row.version !== undefined && row.version !== 1) {
    throw new NotificationInputError("settings.version must be 1");
  }
  const targets = parseTargets(row.targets);
  const defaultQuietHours = parseOptionalQuietHours(
    row.defaultQuietHours,
    "defaultQuietHours"
  );
  const criticalBypassesQuietHours =
    row.criticalBypassesQuietHours === undefined
      ? true
      : parseBoolean(
          row.criticalBypassesQuietHours,
          "criticalBypassesQuietHours"
        );
  const rateLimitPerHour =
    row.rateLimitPerHour === undefined
      ? DEFAULT_RATE_LIMIT_PER_HOUR
      : parseRateLimit(row.rateLimitPerHour);
  return {
    version: 1,
    targets,
    ...(defaultQuietHours ? { defaultQuietHours } : {}),
    criticalBypassesQuietHours,
    rateLimitPerHour,
    updatedAt: now.toISOString(),
  };
}

/** The settings the HTTP API may show: every credential-shaped address is masked. */
export function redactNotificationSettings(
  settings: NotificationSettings
): NotificationSettings {
  return {
    ...settings,
    targets: settings.targets.map((target) => ({
      ...target,
      channel: {
        ...target.channel,
        ...(target.channel.address
          ? { address: redactAddress(target.channel.address) }
          : {}),
      },
    })),
  };
}

/** Validates one external `POST /v1/notifications/send` body. */
export function parseNotification(
  value: unknown,
  options: { now: Date; newId: () => string }
): Notification {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationInputError("notification must be an object");
  }
  const row = value as Record<string, unknown>;
  const id = optionalText(row.id, "id", MAX_ID_LENGTH) ?? options.newId();
  const category = row.category;
  if (!isNoticeCategory(category)) {
    throw new NotificationInputError(
      `category must be one of ${NOTICE_CATEGORIES.join(", ")}`
    );
  }
  const priority = row.priority;
  if (!isNoticePriority(priority)) {
    throw new NotificationInputError(
      `priority must be one of ${NOTICE_PRIORITIES.join(", ")}`
    );
  }
  const title = requiredText(row.title, "title", MAX_LABEL_LENGTH);
  const body = requiredText(row.body, "body", MAX_TEXT_LENGTH);
  const deepLink = optionalText(row.deepLink, "deepLink", MAX_DEEP_LINK_LENGTH);
  const ticketId = optionalText(row.ticketId, "ticketId", MAX_ID_LENGTH);
  const goalId = optionalText(row.goalId, "goalId", MAX_ID_LENGTH);
  const ticketReason = parseTicketReason(row.ticketReason);
  const resource = parseResource(row.resource);
  const createdAtInput = optionalText(row.createdAt, "createdAt", 64);
  const createdAt =
    createdAtInput && Number.isFinite(Date.parse(createdAtInput))
      ? new Date(createdAtInput).toISOString()
      : options.now.toISOString();
  return {
    id,
    category,
    priority,
    title,
    body,
    ...(deepLink ? { deepLink } : {}),
    ...(ticketId ? { ticketId } : {}),
    ...(goalId ? { goalId } : {}),
    ...(ticketReason ? { ticketReason } : {}),
    ...(resource ? { resource } : {}),
    createdAt,
  };
}

export function requireNotificationText(
  value: unknown,
  field: string,
  max = MAX_TEXT_LENGTH
): string {
  return requiredText(value, field, max);
}

function parseTargets(value: unknown): NotificationTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new NotificationInputError("targets must be an array");
  }
  if (value.length > MAX_TARGETS) {
    throw new NotificationInputError(
      `targets must contain at most ${MAX_TARGETS} items`
    );
  }
  const targets: NotificationTarget[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const target = parseTarget(item);
    if (ids.has(target.id)) {
      throw new NotificationInputError(`duplicate target id: ${target.id}`);
    }
    ids.add(target.id);
    targets.push(target);
  }
  return targets;
}

function parseTarget(value: unknown): NotificationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationInputError("each target must be an object");
  }
  const row = value as Record<string, unknown>;
  const id = requiredText(row.id, "target.id", MAX_ID_LENGTH);
  const label = optionalText(row.label, "target.label", MAX_LABEL_LENGTH);
  const channel = parseChannel(row.channel);
  const categories = parseCategories(row.categories);
  const minPriority =
    row.minPriority === undefined
      ? undefined
      : parsePriority(row.minPriority, "target.minPriority");
  const quietHours = parseOptionalQuietHours(
    row.quietHours,
    "target.quietHours"
  );
  const digest = parseDigest(row.digest);
  const enabled =
    row.enabled === undefined
      ? true
      : parseBoolean(row.enabled, "target.enabled");
  return {
    id,
    ...(label ? { label } : {}),
    channel,
    categories,
    ...(minPriority ? { minPriority } : {}),
    ...(quietHours ? { quietHours } : {}),
    ...(digest ? { digest } : {}),
    enabled,
  };
}

function parseChannel(value: unknown): ChannelRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationInputError("target.channel must be an object");
  }
  const row = value as Record<string, unknown>;
  const source = requiredText(
    row.source,
    "target.channel.source",
    MAX_ID_LENGTH
  );
  const thread = requiredText(
    row.thread,
    "target.channel.thread",
    MAX_ID_LENGTH
  );
  if (row.address === undefined) return { source, thread };
  if (
    !row.address ||
    typeof row.address !== "object" ||
    Array.isArray(row.address)
  ) {
    throw new NotificationInputError(
      "target.channel.address must be an object"
    );
  }
  const entries = Object.entries(row.address);
  if (entries.length > MAX_ADDRESS_KEYS) {
    throw new NotificationInputError(
      `target.channel.address must have at most ${MAX_ADDRESS_KEYS} entries`
    );
  }
  const address: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) {
      throw new NotificationInputError(`invalid address key: ${key}`);
    }
    if (typeof item !== "string" || item.length > MAX_ADDRESS_VALUE_LENGTH) {
      throw new NotificationInputError(
        `target.channel.address.${key} must be a string of at most ${MAX_ADDRESS_VALUE_LENGTH} characters`
      );
    }
    address[key] = item;
  }
  return { source, thread, address };
}

function parseCategories(value: unknown): NoticeCategory[] | "all" {
  if (value === undefined) return "all";
  if (value === "all") return "all";
  if (!Array.isArray(value) || value.length === 0) {
    throw new NotificationInputError(
      "target.categories must be 'all' or a non-empty array"
    );
  }
  const categories: NoticeCategory[] = [];
  for (const item of value) {
    if (!isNoticeCategory(item)) {
      throw new NotificationInputError(
        `target.categories must contain only ${NOTICE_CATEGORIES.join(", ")}`
      );
    }
    if (!categories.includes(item)) categories.push(item);
  }
  return categories;
}

function parseDigest(value: unknown): NotificationTarget["digest"] {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationInputError("target.digest must be an object");
  }
  const row = value as Record<string, unknown>;
  const windowMinutes = row.windowMinutes;
  if (
    typeof windowMinutes !== "number" ||
    !Number.isInteger(windowMinutes) ||
    windowMinutes < 1 ||
    windowMinutes > 1440
  ) {
    throw new NotificationInputError(
      "target.digest.windowMinutes must be an integer between 1 and 1440"
    );
  }
  const categories = parseCategories(row.categories);
  return {
    windowMinutes,
    categories: categories === "all" ? [...NOTICE_CATEGORIES] : categories,
  };
}

function parseOptionalQuietHours(
  value: unknown,
  field: string
): QuietHours | undefined {
  try {
    return parseQuietHours(value);
  } catch (error) {
    throw new NotificationInputError(
      `${field}: ${error instanceof Error ? error.message : "invalid quiet hours"}`
    );
  }
}

function parsePriority(value: unknown, field: string): NoticePriority {
  if (!isNoticePriority(value)) {
    throw new NotificationInputError(
      `${field} must be one of ${NOTICE_PRIORITIES.join(", ")}`
    );
  }
  return value;
}

function parseRateLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 10_000
  ) {
    throw new NotificationInputError(
      "rateLimitPerHour must be an integer between 0 and 10000"
    );
  }
  return value;
}

function parseTicketReason(value: unknown): Notification["ticketReason"] {
  if (value === undefined || value === null) return undefined;
  return value === "answer" ||
    value === "review" ||
    value === "blocked" ||
    value === "stalled"
    ? value
    : undefined;
}

function parseResource(value: unknown): Notification["resource"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationInputError("resource must be an object");
  }
  const row = value as Record<string, unknown>;
  return {
    kind: requiredText(row.kind, "resource.kind", MAX_LABEL_LENGTH),
    id: requiredText(row.id, "resource.id", MAX_ID_LENGTH),
  };
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new NotificationInputError(`${field} is required`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new NotificationInputError(
      `${field} must be at most ${max} characters`
    );
  }
  return text;
}

function optionalText(
  value: unknown,
  field: string,
  max: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, field, max);
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new NotificationInputError(`${field} must be a boolean`);
  }
  return value;
}

const SECRET_KEY = /(secret|token|password|passwd|authorization|api[-_]?key)/i;

function redactAddress(
  address: Record<string, string>
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(address)) {
    redacted[key] = SECRET_KEY.test(key) ? "***REDACTED***" : redactUrl(value);
  }
  return redacted;
}

function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return value;
  let changed = false;
  for (const key of url.searchParams.keys()) {
    if (SECRET_KEY.test(key)) {
      url.searchParams.set(key, "***REDACTED***");
      changed = true;
    }
  }
  return changed ? url.toString() : value;
}
