import { MAIN_SESSION_ID } from "../main-session/service.ts";
import {
  type ImAccount,
  type ImAdapterCredentials,
  type ImBinding,
  type ImChat,
  type ImChatKind,
  type ImConversation,
  type ImInbound,
  type ImMediaRef,
  type ImPlatform,
  type ImSendMode,
  type ImSender,
} from "./types.ts";

export const MAX_IM_TEXT = 16_000;
const MAX_ID = 200;
const MAX_LABEL = 100;
const MAX_TITLE = 200;
const MAX_NAME = 100;
const MAX_PLATFORM = 50;
const MAX_TOKEN = 512;
const MAX_CREDENTIAL_KEY = 64;
const MAX_CREDENTIAL_VALUE = 2_048;
const MAX_CREDENTIAL_FIELDS = 20;
const MAX_MENTIONS = 50;
const MAX_MEDIA = 20;

/** A request body the IM routes can reject with a status and a stable code. */
export class ImInputError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "invalid_im_input") {
    super(message);
    this.name = "ImInputError";
    this.status = status;
    this.code = code;
  }
}

export function parseImChat(value: unknown, field = "chat"): ImChat {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError(`${field} must be an object`);
  }
  const row = value as Record<string, unknown>;
  const kind = row.kind;
  if (kind !== "direct" && kind !== "group") {
    throw new ImInputError(`${field}.kind must be "direct" or "group"`);
  }
  const id = requiredId(row.id, `${field}.id`);
  const title = optionalText(row.title, `${field}.title`, MAX_TITLE);
  const threadId = optionalText(row.threadId, `${field}.threadId`, MAX_ID);
  return {
    kind,
    id,
    ...(threadId ? { threadId } : {}),
    ...(title ? { title } : {}),
  };
}

export function parseImSender(value: unknown, field = "sender"): ImSender {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError(`${field} must be an object`);
  }
  const row = value as Record<string, unknown>;
  const id = requiredId(row.id, `${field}.id`);
  const name = optionalText(row.name, `${field}.name`, MAX_NAME);
  return { id, ...(name ? { name } : {}) };
}

export function parseAddChannelInput(value: unknown): {
  platform: ImPlatform;
  label: string;
  credentials: ImAdapterCredentials;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError("channel must be an object");
  }
  const row = value as Record<string, unknown>;
  const platform = requiredSlug(row.platform, "platform", MAX_PLATFORM);
  const label = optionalText(row.label, "label", MAX_LABEL) ?? "IM channel";
  let credentials: ImAdapterCredentials;
  if (row.credentials !== undefined) {
    credentials = parseImCredentials(row.credentials, "credentials");
  } else if (typeof row.token === "string") {
    // Backward-compatible shorthand for the Telegram-shaped channel body.
    const token = row.token.trim();
    if (!token) throw new ImInputError("token is required");
    if (token.length > MAX_TOKEN || /\s/.test(token)) {
      throw new ImInputError(
        `token must be at most ${MAX_TOKEN} characters and contain no spaces`
      );
    }
    credentials = { token };
  } else {
    throw new ImInputError("credentials are required");
  }
  if (Object.keys(credentials).length === 0) {
    throw new ImInputError("credentials must contain at least one field");
  }
  return { platform, label, credentials };
}

export function parseImCredentials(
  value: unknown,
  field = "credentials"
): ImAdapterCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError(`${field} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CREDENTIAL_FIELDS) {
    throw new ImInputError(
      `${field} must contain at most ${MAX_CREDENTIAL_FIELDS} fields`
    );
  }
  const credentials: ImAdapterCredentials = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (!key || key.length > MAX_CREDENTIAL_KEY) {
      throw new ImInputError(
        `${field} keys must be 1-${MAX_CREDENTIAL_KEY} characters`
      );
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new ImInputError(`${field} contains an invalid key`);
    }
    if (typeof rawValue !== "string") {
      throw new ImInputError(`${field}.${key} must be a string`);
    }
    const text = rawValue.trim();
    if (!text) throw new ImInputError(`${field}.${key} is required`);
    if (text.length > MAX_CREDENTIAL_VALUE) {
      throw new ImInputError(
        `${field}.${key} must be at most ${MAX_CREDENTIAL_VALUE} characters`
      );
    }
    credentials[key] = text;
  }
  return credentials;
}

export function parseLoginStartInput(value: unknown): {
  platform: ImPlatform;
  label: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError("login must be an object");
  }
  const row = value as Record<string, unknown>;
  return {
    platform: requiredSlug(row.platform, "platform", MAX_PLATFORM),
    label: optionalText(row.label, "label", MAX_LABEL) ?? "IM channel",
  };
}

export function parseBindInput(value: unknown): {
  accountId: string;
  chat: ImChat;
  sessionId: string;
  role: "owner" | "guest";
  senderId?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError("binding must be an object");
  }
  const row = value as Record<string, unknown>;
  const accountId = requiredId(row.accountId, "accountId");
  const chat = parseImChat(row.chat);
  if (row.role !== undefined && row.role !== "owner" && row.role !== "guest") {
    throw new ImInputError('role must be "owner" or "guest"');
  }
  const role = row.role === "guest" ? "guest" : "owner";
  const sessionId =
    optionalText(row.sessionId, "sessionId", MAX_ID) ?? MAIN_SESSION_ID;
  const senderId = optionalText(row.senderId, "senderId", MAX_ID);
  return {
    accountId,
    chat,
    sessionId,
    role,
    ...(senderId ? { senderId } : {}),
  };
}

export function parseSendInput(value: unknown): {
  accountId: string;
  chat: Pick<ImChat, "kind" | "id">;
  text: string;
  mode: ImSendMode;
  replyTo?: string;
  contextToken?: string;
  idempotencyKey?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError("send must be an object");
  }
  const row = value as Record<string, unknown>;
  const accountId = requiredId(row.accountId, "accountId");
  const chat = parseImChat(row.chat);
  const text = requiredText(row.text, "text", MAX_IM_TEXT);
  if (
    row.mode !== undefined &&
    row.mode !== "reply" &&
    row.mode !== "proactive"
  ) {
    throw new ImInputError('mode must be "reply" or "proactive"');
  }
  const mode: ImSendMode = row.mode === "reply" ? "reply" : "proactive";
  const replyTo = optionalText(row.replyTo, "replyTo", MAX_ID);
  const contextToken = optionalText(
    row.contextToken,
    "contextToken",
    MAX_TOKEN
  );
  const idempotencyKey = optionalText(
    row.idempotencyKey,
    "idempotencyKey",
    MAX_ID
  );
  return {
    accountId,
    chat: {
      kind: chat.kind,
      id: chat.id,
      ...(chat.threadId ? { threadId: chat.threadId } : {}),
    },
    text,
    mode,
    ...(replyTo ? { replyTo } : {}),
    ...(contextToken ? { contextToken } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/** Validates a persisted state row. A corrupt file should surface, not silently erase bindings. */
export function parseImAccount(value: unknown): ImAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError("account must be an object");
  }
  const row = value as Record<string, unknown>;
  return {
    id: requiredId(row.id, "account.id"),
    platform: requiredSlug(row.platform, "account.platform", MAX_PLATFORM),
    label: optionalText(row.label, "account.label", MAX_LABEL) ?? "IM channel",
    enabled: row.enabled === undefined ? true : row.enabled === true,
    createdAt: isoDate(row.createdAt, "account.createdAt"),
  };
}

export function parseImBinding(value: unknown): ImBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError("binding must be an object");
  }
  const row = value as Record<string, unknown>;
  if (row.role !== undefined && row.role !== "owner" && row.role !== "guest") {
    throw new ImInputError('binding.role must be "owner" or "guest"');
  }
  const role = row.role === "guest" ? "guest" : "owner";
  const senderId = optionalText(row.senderId, "binding.senderId", MAX_ID);
  return {
    id: requiredId(row.id, "binding.id"),
    accountId: requiredId(row.accountId, "binding.accountId"),
    chat: parseImChat(row.chat, "binding.chat"),
    sessionId:
      optionalText(row.sessionId, "binding.sessionId", MAX_ID) ??
      MAIN_SESSION_ID,
    role,
    ...(senderId ? { senderId } : {}),
    createdAt: isoDate(row.createdAt, "binding.createdAt"),
  };
}

export function parseImConversation(value: unknown): ImConversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError("conversation must be an object");
  }
  const row = value as Record<string, unknown>;
  return {
    accountId: requiredId(row.accountId, "conversation.accountId"),
    platform: requiredSlug(row.platform, "conversation.platform", MAX_PLATFORM),
    chat: parseImChat(row.chat, "conversation.chat"),
    sender: parseImSender(row.sender, "conversation.sender"),
    lastMessageId: requiredId(row.lastMessageId, "conversation.lastMessageId"),
    lastSeenAt: isoDate(row.lastSeenAt, "conversation.lastSeenAt"),
  };
}

export function parseImInbound(value: unknown): ImInbound {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImInputError("inbound must be an object");
  }
  const row = value as Record<string, unknown>;
  const updateId = optionalText(row.updateId, "inbound.updateId", MAX_ID);
  const replyTo = optionalText(row.replyTo, "inbound.replyTo", MAX_ID);
  const contextToken = optionalText(
    row.contextToken,
    "inbound.contextToken",
    MAX_TOKEN
  );
  const replyAuthor = optionalText(
    row.replyAuthor,
    "inbound.replyAuthor",
    MAX_NAME
  );
  const mentions = parseMentions(row.mentions);
  const media = parseMedia(row.media);
  const text = typeof row.text === "string" ? row.text.trim() : "";
  if (!text && media.length === 0) {
    throw new ImInputError("inbound.text is required");
  }
  if (text.length > MAX_IM_TEXT) {
    throw new ImInputError(
      `inbound.text must be at most ${MAX_IM_TEXT} characters`
    );
  }
  return {
    platform: requiredSlug(row.platform, "inbound.platform", MAX_PLATFORM),
    accountId: requiredId(row.accountId, "inbound.accountId"),
    chat: parseImChat(row.chat, "inbound.chat"),
    sender: parseImSender(row.sender, "inbound.sender"),
    messageId: requiredId(row.messageId, "inbound.messageId"),
    ...(updateId ? { updateId } : {}),
    text,
    ...(replyTo ? { replyTo } : {}),
    ...(contextToken ? { contextToken } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(media.length > 0 ? { media } : {}),
    ...(replyAuthor ? { replyAuthor } : {}),
    receivedAt: isoDate(row.receivedAt, "inbound.receivedAt"),
  };
}

function parseMentions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MENTIONS) {
    throw new ImInputError(
      `inbound.mentions must be an array of at most ${MAX_MENTIONS} ids`
    );
  }
  return value.map((entry) => requiredId(entry, "inbound.mentions"));
}

function parseMedia(value: unknown): ImMediaRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MEDIA) {
    throw new ImInputError(
      `inbound.media must be an array of at most ${MAX_MEDIA} items`
    );
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ImInputError(`inbound.media[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    const kind = row.kind;
    if (
      kind !== "image" &&
      kind !== "audio" &&
      kind !== "video" &&
      kind !== "file"
    ) {
      throw new ImInputError(
        `inbound.media[${index}].kind must be image, audio, video or file`
      );
    }
    const mimeType = optionalText(
      row.mimeType,
      `inbound.media[${index}].mimeType`,
      MAX_NAME
    );
    const size =
      typeof row.size === "number" && Number.isFinite(row.size) && row.size >= 0
        ? row.size
        : undefined;
    return {
      kind,
      id: requiredId(row.id, `inbound.media[${index}].id`),
      ...(mimeType ? { mimeType } : {}),
      ...(size !== undefined ? { size } : {}),
    };
  });
}

export function isImChatKind(value: unknown): value is ImChatKind {
  return value === "direct" || value === "group";
}

function requiredSlug(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new ImInputError(`${field} must be a platform slug`);
  }
  const text = value.trim();
  if (!text || text.length > max || !/^[a-z0-9][a-z0-9_-]*$/i.test(text)) {
    throw new ImInputError(
      `${field} must be a platform slug of at most ${max} characters`
    );
  }
  return text;
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ImInputError(`${field} is required`);
  }
  const text = String(value).trim();
  if (!text) throw new ImInputError(`${field} is required`);
  if (text.length > MAX_ID) {
    throw new ImInputError(`${field} must be at most ${MAX_ID} characters`);
  }
  return text;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ImInputError(`${field} is required`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new ImInputError(`${field} must be at most ${max} characters`);
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

function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ImInputError(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}
