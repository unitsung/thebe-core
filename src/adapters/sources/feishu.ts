import type { ChannelAdapter } from "../../agent/channels/types.ts";
import type {
  ChannelRef,
  Source,
  SourceAdmission,
  Trigger,
} from "../../agent/sources/types.ts";
import { key } from "../../agent/tickets/ids.ts";

export const FEISHU_SOURCE_ID = "feishu";

const DEFAULT_API_BASE_URL = "https://open.feishu.cn";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SEEN_MESSAGES = 300;

export const FEISHU_ASSESSED_KINDS = ["feishu.message"] as const;

type FetchLike = typeof fetch;

type FeishuMessage = {
  messageId: string;
  chatId: string;
  createTime: string;
  text: string;
  senderId: string;
  senderType: string;
  mentionIds: string[];
};

type ChatCursor = {
  initialized: boolean;
  lastCreateTime: string;
  seen: string[];
};

type Cursor = {
  n: number;
  chats: Record<string, ChatCursor>;
};

export type FeishuSourceOptions = {
  appId: string;
  appSecret: string;
  /** Chat ids (`oc_…`) to poll. */
  chats: readonly string[];
  /** The bot's own open id, so a mention can be recognised without parsing text. */
  botOpenId?: string;
  /** Display names the person may type to address the bot, without the leading `@`. */
  mentionNames?: readonly string[];
  /** Treat human messages that did not mention the bot as inferred work for Eval. Off by default. */
  admitUnaddressed?: boolean;
  apiBaseUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
};

/**
 * Polls messages in configured Feishu chats. A direct chat or an `@` mention is an explicit human
 * request; a bot or webhook message is ignored; an unaddressed group message only reaches Eval when
 * the operator asks for it. The Source owns this deterministic admission, so the model never sees
 * messages the person did not address to it by default.
 */
export function createFeishuSource(options: FeishuSourceOptions): Source {
  const chats = normalizeChats(options.chats);
  if (chats.length === 0) {
    throw new Error("Feishu Source needs at least one chat id");
  }
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const apiBaseUrl = trimSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const token = createTokenCache({
    fetcher,
    apiBaseUrl,
    appId: options.appId,
    appSecret: options.appSecret,
    now,
  });
  const chatModes = new Map<string, Promise<"p2p" | "group" | undefined>>();

  function chatMode(chatId: string): Promise<"p2p" | "group" | undefined> {
    const pending = chatModes.get(chatId);
    if (pending) return pending;
    const flight = feishuRequest({
      fetcher,
      apiBaseUrl,
      token,
      now,
      path: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      method: "GET",
    })
      .then((data) => {
        const mode = recordValue(data)?.chat_mode;
        return mode === "p2p" || mode === "group" ? mode : undefined;
      })
      .catch(() => undefined);
    chatModes.set(chatId, flight);
    return flight;
  }

  return {
    id: FEISHU_SOURCE_ID,
    scope: `Feishu messages (${chats.join(", ")})`,
    assessedKinds: FEISHU_ASSESSED_KINDS,
    admit: (trigger) =>
      trigger.admission ?? (trigger.human ? "inferred" : "ignore"),
    async read(rawCursor, signal) {
      const previous = parseCursor(rawCursor);
      const next: Cursor = {
        n: previous?.n ?? 0,
        chats: { ...previous?.chats },
      };
      const triggers: Trigger[] = [];
      const endTime = String(Math.floor(now().getTime() / 1000));

      for (const chatId of chats) {
        const saved = previous?.chats[chatId] ?? {
          initialized: false,
          lastCreateTime: "0",
          seen: [],
        };
        const startTime = saved.initialized
          ? String(
              Math.max(0, Math.floor(Number(saved.lastCreateTime) / 1000) - 1)
            )
          : String(
              Math.max(0, Math.floor(now().getTime() / 1000) - 24 * 60 * 60)
            );
        const messages = await readMessages({
          fetcher,
          apiBaseUrl,
          token,
          now,
          chatId,
          startTime,
          endTime,
          signal,
        });
        const seen = new Set(saved.seen);
        const fresh = messages.filter(
          (message) => !seen.has(message.messageId)
        );
        const latest = messages.reduce(
          (max, message) =>
            message.createTime > max ? message.createTime : max,
          saved.lastCreateTime
        );
        next.chats[chatId] = {
          initialized: true,
          lastCreateTime: latest,
          seen: [
            ...messages.map((message) => message.messageId),
            ...saved.seen.filter(
              (id) => !messages.some((message) => message.messageId === id)
            ),
          ].slice(0, MAX_SEEN_MESSAGES),
        };
        if (!saved.initialized) continue;
        next.n += 1;

        const mode = await chatMode(chatId);
        for (const message of fresh.sort((left, right) =>
          left.createTime.localeCompare(right.createTime)
        )) {
          const trigger = await toTrigger(message, {
            mode,
            botOpenId: options.botOpenId,
            mentionNames: options.mentionNames ?? [],
            admitUnaddressed: options.admitUnaddressed === true,
            now,
          });
          if (trigger) triggers.push(trigger);
        }
      }

      return { triggers, cursor: JSON.stringify(next) };
    },
  };
}

export type FeishuChannelOptions = {
  appId: string;
  appSecret: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** When set, the adapter refuses chats outside this list. */
  chats?: readonly string[];
};

/** Sends a Ticket notice back into a Feishu chat. */
export function createFeishuChannelAdapter(
  options: FeishuChannelOptions
): ChannelAdapter {
  const allowed = options.chats
    ? new Set(normalizeChats(options.chats))
    : undefined;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const apiBaseUrl = trimSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const token = createTokenCache({
    fetcher,
    apiBaseUrl,
    appId: options.appId,
    appSecret: options.appSecret,
    now,
  });

  return {
    id: FEISHU_SOURCE_ID,
    accepts(channel) {
      const chat = parseChat(channel);
      return Boolean(chat) && (!allowed || allowed.has(chat!));
    },
    async send(input) {
      const chat = parseChat(input.channel);
      if (!chat) throw new Error("invalid Feishu chat channel");
      await feishuRequest({
        fetcher,
        apiBaseUrl,
        token,
        now,
        path: "/open-apis/im/v1/messages?receive_id_type=chat_id",
        method: "POST",
        body: {
          receive_id: chat,
          msg_type: "text",
          content: JSON.stringify({
            text: truncate(input.notice.message, 20_000),
          }),
          // Feishu deduplicates repeated sends with the same uuid.
          uuid: input.idempotencyKey.slice(0, 50),
        },
      });
    },
  };
}

/** Builds the production Source and Channel adapter from environment variables, or nothing. */
export function createFeishuFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { source: Source; channel: ChannelAdapter } | undefined {
  const appId = env.THEBE_FEISHU_APP_ID?.trim();
  const appSecret = env.THEBE_FEISHU_APP_SECRET?.trim();
  const chats = (env.THEBE_FEISHU_CHATS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!appId || !appSecret || chats.length === 0) return undefined;
  const common = {
    appId,
    appSecret,
    chats,
    ...(env.THEBE_FEISHU_API_URL?.trim()
      ? { apiBaseUrl: env.THEBE_FEISHU_API_URL.trim() }
      : {}),
  };
  return {
    source: createFeishuSource({
      ...common,
      ...(env.THEBE_FEISHU_BOT_OPEN_ID?.trim()
        ? { botOpenId: env.THEBE_FEISHU_BOT_OPEN_ID.trim() }
        : {}),
      ...(env.THEBE_FEISHU_MENTIONS?.trim()
        ? {
            mentionNames: env.THEBE_FEISHU_MENTIONS.split(",")
              .map((name) => name.trim())
              .filter(Boolean),
          }
        : {}),
      ...(env.THEBE_FEISHU_ADMIT_UNMENTIONED === "1"
        ? { admitUnaddressed: true }
        : {}),
    }),
    channel: createFeishuChannelAdapter(common),
  };
}

async function toTrigger(
  message: FeishuMessage,
  policy: {
    mode: "p2p" | "group" | undefined;
    botOpenId?: string;
    mentionNames: readonly string[];
    admitUnaddressed: boolean;
    now: () => Date;
  }
): Promise<Trigger | undefined> {
  const human = message.senderType === "user";
  const named = policy.mentionNames.some((name) =>
    message.text.includes(`@${name}`)
  );
  const mention = policy.botOpenId
    ? message.mentionIds.includes(policy.botOpenId) || named
    : message.mentionIds.length > 0 || named;
  const explicit = human && (policy.mode === "p2p" || mention);
  const admission: SourceAdmission = !human
    ? "ignore"
    : explicit
      ? "explicit"
      : policy.admitUnaddressed
        ? "inferred"
        : "ignore";
  const thread = `resource:${FEISHU_SOURCE_ID}:chat:${message.chatId}`;
  const channel: ChannelRef = {
    source: FEISHU_SOURCE_ID,
    thread,
    address: { chat: message.chatId },
  };
  return {
    id: key("trigger", FEISHU_SOURCE_ID, message.chatId, message.messageId),
    source: FEISHU_SOURCE_ID,
    kind: "feishu.message",
    at: new Date(Number(message.createTime)).toISOString(),
    threads: [thread],
    resource: { kind: FEISHU_SOURCE_ID, id: message.chatId },
    payload: {
      chatId: message.chatId,
      messageId: message.messageId,
      text: truncate(message.text, 8_000),
      mention,
    },
    actor: { source: FEISHU_SOURCE_ID, id: message.senderId },
    human,
    admission,
    ...(mention
      ? { addressed: "mention" as const }
      : { addressed: "direct" as const }),
    channel,
  };
}

async function readMessages(input: {
  fetcher: FetchLike;
  apiBaseUrl: string;
  token: ReturnType<typeof createTokenCache>;
  now: () => Date;
  chatId: string;
  startTime: string;
  endTime: string;
  signal?: AbortSignal;
}): Promise<FeishuMessage[]> {
  const data = await feishuRequest({
    fetcher: input.fetcher,
    apiBaseUrl: input.apiBaseUrl,
    token: input.token,
    now: input.now,
    path:
      "/open-apis/im/v1/messages?container_id_type=chat" +
      `&container_id=${encodeURIComponent(input.chatId)}` +
      `&start_time=${input.startTime}&end_time=${input.endTime}` +
      "&sort_type=ByCreateTimeAsc&page_size=50",
    method: "GET",
    signal: input.signal,
  });
  const items = recordValue(data)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => parseMessage(item, input.chatId))
    .filter((message): message is FeishuMessage => message !== undefined);
}

function parseMessage(
  value: unknown,
  fallbackChatId: string
): FeishuMessage | undefined {
  const item = recordValue(value);
  if (!item) return undefined;
  const messageId = stringValue(item.message_id);
  const createTime = stringValue(item.create_time);
  const msgType = stringValue(item.msg_type);
  const sender = recordValue(item.sender);
  const senderId =
    stringValue(recordValue(sender?.id)?.open_id) ?? stringValue(sender?.id);
  const senderType = stringValue(sender?.sender_type) ?? "unknown";
  const chatId = stringValue(item.chat_id) ?? fallbackChatId;
  const body = recordValue(item.body);
  if (!messageId || !createTime || !senderId || msgType !== "text") {
    return undefined;
  }
  const parsedContent = parseContent(stringValue(body?.content));
  if (parsedContent === undefined) return undefined;
  const mentions = Array.isArray(item.mentions) ? item.mentions : [];
  const mentionIds = mentions.flatMap((mention) => {
    const record = recordValue(mention);
    const id = stringValue(recordValue(record?.id)?.open_id);
    return id ? [id] : [];
  });
  return {
    messageId,
    chatId,
    createTime,
    text: parsedContent,
    senderId,
    senderType,
    mentionIds,
  };
}

function parseContent(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : undefined;
  } catch {
    return undefined;
  }
}

function createTokenCache(input: {
  fetcher: FetchLike;
  apiBaseUrl: string;
  appId: string;
  appSecret: string;
  now: () => Date;
}): () => Promise<string> {
  let token: string | undefined;
  let expiresAt = 0;
  let pending: Promise<string> | undefined;
  return async () => {
    if (token && input.now().getTime() < expiresAt) return token;
    if (pending) return pending;
    pending = (async () => {
      const response = await input.fetcher(
        `${input.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            app_id: input.appId,
            app_secret: input.appSecret,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );
      if (!response.ok) {
        throw new Error(`Feishu token request failed: ${response.status}`);
      }
      const body = (await response.json()) as {
        code?: unknown;
        tenant_access_token?: unknown;
        expire?: unknown;
      };
      const fresh = stringValue(body.tenant_access_token);
      if (body.code !== 0 || !fresh) {
        throw new Error("Feishu refused the app credentials");
      }
      token = fresh;
      const seconds =
        typeof body.expire === "number" && body.expire > 0 ? body.expire : 3600;
      expiresAt = input.now().getTime() + (seconds - 60) * 1000;
      return fresh;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

async function feishuRequest(input: {
  fetcher: FetchLike;
  apiBaseUrl: string;
  token: () => Promise<string>;
  now: () => Date;
  path: string;
  method: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<unknown> {
  const token = await input.token();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await input.fetcher(`${input.apiBaseUrl}${input.path}`, {
    method: input.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(input.body !== undefined
        ? { "content-type": "application/json; charset=utf-8" }
        : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
  if (!response.ok) {
    throw new Error(`Feishu request failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    code?: unknown;
    msg?: unknown;
    data?: unknown;
  };
  if (body.code !== 0) {
    throw new Error(
      `Feishu request refused: ${String(body.code)} ${stringValue(body.msg) ?? ""}`.trim()
    );
  }
  return body.data;
}

function parseChat(channel: ChannelRef): string | undefined {
  if (channel.source !== FEISHU_SOURCE_ID) return undefined;
  const chat = channel.address?.chat;
  return chat && /^[A-Za-z0-9_-]+$/.test(chat) ? chat : undefined;
}

function normalizeChats(chats: readonly string[]): string[] {
  return [
    ...new Set(
      chats
        .map((chat) => chat.trim())
        .filter((chat) => /^[A-Za-z0-9_-]+$/.test(chat))
    ),
  ];
}

function parseCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { n?: unknown; chats?: unknown };
    if (
      typeof parsed.n === "number" &&
      parsed.chats &&
      typeof parsed.chats === "object" &&
      !Array.isArray(parsed.chats)
    ) {
      const chats: Record<string, ChatCursor> = {};
      for (const [chatId, value] of Object.entries(
        parsed.chats as Record<string, unknown>
      )) {
        const record = recordValue(value);
        if (!record) continue;
        chats[chatId] = {
          initialized: record.initialized !== false,
          lastCreateTime:
            typeof record.lastCreateTime === "string"
              ? record.lastCreateTime
              : "0",
          seen: Array.isArray(record.seen)
            ? record.seen.filter(
                (entry): entry is string => typeof entry === "string"
              )
            : [],
        };
      }
      return { n: parsed.n, chats };
    }
  } catch {
    // A new baseline is safer than replaying every message in a chat.
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
