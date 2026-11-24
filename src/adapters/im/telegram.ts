import { createHash } from "node:crypto";
import type {
  ImAccount,
  ImAdapter,
  ImAdapterCredentials,
  ImCapabilities,
  ImHealth,
  ImInbound,
  ImMediaFetchInput,
  ImMediaFetchResult,
  ImMediaRef,
  ImOutboundMedia,
  ImSendInput,
  ImSendResult,
} from "../../agent/im/types.ts";
import { MediaDownloadLimitError, readBoundedResponseBody } from "./media.ts";

export const TELEGRAM_MAX_TEXT = 4_096;
const DEFAULT_POLL_TIMEOUT_SECONDS = 50;
const REQUEST_TIMEOUT_MS = 65_000;
const MAX_TEXT = 16_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

/** A cursor belongs to one bot token; a rotated token must not resume the old update offset. */
export function telegramCursorIdentity(
  credentials: ImAdapterCredentials
): string | undefined {
  const token = credentials.token?.trim();
  if (!token) return undefined;
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function validateTelegramCredentials(
  credentials: ImAdapterCredentials
): string | undefined {
  const token = credentials.token?.trim();
  if (!token) return "missing credential: token";
  if (/\s/.test(token)) {
    return "telegram bot token must not contain spaces";
  }
  return undefined;
}

type TelegramErrorKind =
  | "network"
  | "unauthorized"
  | "conflict"
  | "rate_limit"
  | "server"
  | "bad_request";

class TelegramRequestError extends Error {
  readonly kind: TelegramErrorKind;
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(
    kind: TelegramErrorKind,
    message: string,
    options: { retryAfterMs?: number; status?: number } = {}
  ) {
    super(message);
    this.name = "TelegramRequestError";
    this.kind = kind;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }
}

/**
 * Telegram Bot API adapter. It long-polls `getUpdates` (no public webhook needed) and sends plain
 * text: user content is never handed to a parse mode, so a stray `*` cannot break a reply. The
 * cursor is `update_id + 1`; the gateway persists it and deduplicates redelivery.
 */
export function createTelegramImAdapter(input: {
  account: ImAccount;
  credentials: ImAdapterCredentials;
  cursor?: string;
  onCursor(cursor: string): void;
  onError?(message: string): void;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Tests and self-hosted proxies point this at a local fake. */
  apiBase?: string;
  pollTimeoutSeconds?: number;
}): ImAdapter {
  const now = input.now ?? (() => new Date());
  const sendFetch = input.fetch ?? fetch;
  const token = input.credentials.token?.trim() ?? "";
  const apiBase = (
    input.apiBase ??
    process.env.THEBE_TELEGRAM_API_BASE ??
    "https://api.telegram.org"
  ).replace(/\/+$/, "");
  const pollTimeout = clampInt(
    input.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
    1,
    50
  );
  const capabilities: ImCapabilities = {
    proactive: true,
    replyOnly: false,
    recall: false,
    media: true,
    maxTextLength: TELEGRAM_MAX_TEXT,
    markdown: false,
    threads: true,
    typing: false,
  };
  let health: ImHealth = { state: "stopped" };
  let offset = parseOffset(input.cursor);
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let floodUntil = 0;
  let sendChain: Promise<unknown> = Promise.resolve();
  let inbound: ((message: ImInbound) => Promise<void>) | undefined;

  function endpoint(method: string): string {
    return `${apiBase}/bot${token}/${method}`;
  }

  async function request(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<Record<string, unknown>> {
    if (!token) {
      throw new TelegramRequestError("unauthorized", "bot token is missing");
    }
    const signal = combineSignals(
      controller?.signal,
      AbortSignal.timeout(timeoutMs)
    );
    let response: Response;
    try {
      response = await sendFetch(endpoint(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new TelegramRequestError("network", "stopped");
      }
      // The URL contains the token; never rethrow the fetch error as-is.
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new TelegramRequestError("network", "telegram request timed out");
      }
      throw new TelegramRequestError("network", "telegram request failed");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramRequestError(
        response.status >= 500 ? "server" : "bad_request",
        `telegram returned HTTP ${response.status}`,
        { status: response.status }
      );
    }
    const row =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    if (response.ok && row.ok !== false) return row;
    const description = safeDescription(row.description);
    const retryAfterMs = retryAfterFrom(row);
    if (response.status === 401 || response.status === 404) {
      throw new TelegramRequestError("unauthorized", description, {
        status: response.status,
      });
    }
    if (response.status === 409) {
      throw new TelegramRequestError("conflict", description, {
        status: 409,
      });
    }
    if (response.status === 429) {
      throw new TelegramRequestError(
        "rate_limit",
        description || "telegram rate limited the request",
        { status: 429, ...(retryAfterMs ? { retryAfterMs } : {}) }
      );
    }
    if (response.status >= 500) {
      throw new TelegramRequestError("server", description, {
        status: response.status,
      });
    }
    throw new TelegramRequestError("bad_request", description, {
      status: response.status,
    });
  }

  async function getUpdates(): Promise<unknown[]> {
    const row = await request(
      "getUpdates",
      {
        offset,
        timeout: pollTimeout,
        allowed_updates: ["message"],
      },
      (pollTimeout + 15) * 1_000
    );
    if (!Array.isArray(row.result)) {
      throw new TelegramRequestError(
        "server",
        "telegram returned no update list"
      );
    }
    return row.result;
  }

  async function pollLoop(): Promise<void> {
    let backoff = 0;
    while (!controller?.signal.aborted) {
      try {
        await waitForFloodWindow(controller?.signal);
        const updates = await getUpdates();
        health = { state: "connected" };
        backoff = 0;
        for (const update of updates) {
          if (controller?.signal.aborted) return;
          const updateId = numeric(record(update).update_id);
          const message = parseUpdate(update, input.account.id, now());
          if (message && inbound) {
            try {
              await inbound(message);
            } catch {
              // The gateway records its own failure; a poison message must not stop polling.
            }
          }
          if (updateId !== undefined) {
            offset = updateId + 1;
            input.onCursor(String(offset));
          }
        }
      } catch (error) {
        if (controller?.signal.aborted) return;
        const failure =
          error instanceof TelegramRequestError
            ? error
            : new TelegramRequestError("network", "telegram polling failed");
        if (failure.kind === "conflict") {
          health = {
            state: "error",
            detail:
              "another process is polling this bot (Telegram returned 409)",
          };
          input.onError?.(health.detail ?? "telegram polling conflict");
          return;
        }
        if (failure.kind === "unauthorized") {
          health = {
            state: "needs_login",
            detail: "Telegram rejected the bot token",
          };
          input.onError?.(health.detail ?? "telegram authorization failed");
          return;
        }
        if (failure.kind === "rate_limit") {
          floodUntil = Math.max(
            floodUntil,
            now().getTime() + (failure.retryAfterMs ?? 1_000)
          );
          health = {
            state: "error",
            detail: "Telegram rate limited polling; retrying after its window",
          };
          input.onError?.(health.detail ?? "telegram rate limited");
          continue;
        }
        health = {
          state: "error",
          detail:
            failure.kind === "server"
              ? "Telegram is temporarily unavailable"
              : "Telegram polling failed",
        };
        input.onError?.(health.detail ?? "telegram polling failed");
        const wait = BACKOFF_MS[Math.min(backoff, BACKOFF_MS.length - 1)]!;
        backoff += 1;
        await sleep(wait + Math.floor(Math.random() * 250), controller?.signal);
      }
    }
  }

  async function waitForFloodWindow(signal?: AbortSignal): Promise<void> {
    const wait = floodUntil - now().getTime();
    if (wait > 0) await sleep(Math.min(wait, 60_000), signal);
  }

  async function sendMessageBody(
    payload: Record<string, unknown>
  ): Promise<{ messageId?: string }> {
    while (true) {
      await waitForFloodWindow(controller?.signal);
      try {
        const row = await request("sendMessage", payload, 20_000);
        const messageId = numeric(record(row.result).message_id);
        return messageId === undefined ? {} : { messageId: String(messageId) };
      } catch (error) {
        if (
          error instanceof TelegramRequestError &&
          error.kind === "rate_limit"
        ) {
          const retryAfter = error.retryAfterMs ?? 1_000;
          floodUntil = Math.max(floodUntil, now().getTime() + retryAfter);
          if (retryAfter <= 60_000) {
            await sleep(retryAfter, controller?.signal);
            continue;
          }
        }
        throw error;
      }
    }
  }

  async function sendChunks(input: ImSendInput): Promise<ImSendResult> {
    if (!token) return { status: "discard", reason: "token_missing" };
    if (controller?.signal.aborted) {
      return { status: "discard", reason: "channel_stopped" };
    }
    const chunks = chunkTelegramText(input.text);
    if (chunks.length === 0) return { status: "discard", reason: "empty_text" };
    let lastMessageId: string | undefined;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      let body: Record<string, unknown> = {
        chat_id: input.chat.id,
        text: chunk,
        link_preview_options: { is_disabled: true },
      };
      if (input.chat.threadId) {
        const threadId = numeric(input.chat.threadId);
        if (threadId !== undefined) body.message_thread_id = threadId;
      }
      if (input.mode === "reply" && input.replyTo && index === 0) {
        const replyTo = numeric(input.replyTo);
        if (replyTo !== undefined) {
          body = {
            ...body,
            reply_parameters: {
              message_id: replyTo,
              allow_sending_without_reply: true,
            },
          };
        }
      }
      try {
        const sent = await sendMessageBody(body);
        if (sent.messageId) lastMessageId = sent.messageId;
      } catch (error) {
        return classificationFor(error);
      }
    }
    return {
      status: "sent",
      ...(lastMessageId ? { platformMessageId: lastMessageId } : {}),
    };
  }

  function mediaMethod(media: ImOutboundMedia): string {
    if (media.kind === "image" || media.mediaType.startsWith("image/")) {
      return "sendPhoto";
    }
    if (media.kind === "audio" || media.mediaType.startsWith("audio/")) {
      return "sendAudio";
    }
    if (media.kind === "video" || media.mediaType.startsWith("video/")) {
      return "sendVideo";
    }
    return "sendDocument";
  }

  async function sendMedia(input: ImSendInput): Promise<ImSendResult> {
    if (!token) return { status: "discard", reason: "token_missing" };
    if (controller?.signal.aborted) {
      return { status: "discard", reason: "channel_stopped" };
    }
    const media = input.media ?? [];
    if (media.length === 0) return sendChunks(input);
    let lastMessageId: string | undefined;
    let replyClaimed = false;
    let captionUsed = false;
    for (const item of media) {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(item.data, "base64");
      } catch {
        return { status: "discard", reason: "invalid_media" };
      }
      if (bytes.length === 0 || bytes.length > 2_000_000) {
        return { status: "discard", reason: "invalid_media" };
      }
      const form = new FormData();
      form.set("chat_id", input.chat.id);
      if (input.chat.threadId) {
        const threadId = numeric(input.chat.threadId);
        if (threadId !== undefined)
          form.set("message_thread_id", String(threadId));
      }
      if (input.mode === "reply" && input.replyTo && !replyClaimed) {
        const replyTo = numeric(input.replyTo);
        if (replyTo !== undefined) {
          form.set(
            "reply_parameters",
            JSON.stringify({
              message_id: replyTo,
              allow_sending_without_reply: true,
            })
          );
          replyClaimed = true;
        }
      }
      const caption = input.text.trim();
      if (caption && !captionUsed) {
        form.set("caption", caption.slice(0, 1_024));
        captionUsed = true;
      }
      const method = mediaMethod(item);
      form.set(
        method.slice("send".length).toLowerCase(),
        new Blob([bytes], { type: item.mediaType }),
        item.filename || `thebe-media-${media.indexOf(item) + 1}`
      );
      try {
        const row = await uploadForm(method, form);
        const result = record(row.result);
        const messageId = numeric(result.message_id);
        if (messageId !== undefined) lastMessageId = String(messageId);
      } catch (error) {
        return classificationFor(error);
      }
    }
    if (input.text.trim().length > 1_024) {
      const rest = await sendChunks({
        ...input,
        text: input.text.trim().slice(1_024),
        mode: "proactive",
        replyTo: undefined,
        media: undefined,
      });
      if (rest.status === "sent" && rest.platformMessageId) {
        lastMessageId = rest.platformMessageId;
      }
      if (rest.status !== "sent") return rest;
    }
    return {
      status: "sent",
      ...(lastMessageId ? { platformMessageId: lastMessageId } : {}),
    };
  }

  async function uploadForm(
    method: string,
    form: FormData
  ): Promise<Record<string, unknown>> {
    const signal = combineSignals(
      controller?.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    );
    let response: Response;
    try {
      response = await sendFetch(endpoint(method), {
        method: "POST",
        body: form,
        signal,
      });
    } catch {
      throw new TelegramRequestError("network", "telegram upload failed");
    }
    const payload = await response.json().catch(() => ({}));
    const row =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    if (response.ok && row.ok !== false) return row;
    if (response.status === 401 || response.status === 404) {
      throw new TelegramRequestError(
        "unauthorized",
        safeDescription(row.description)
      );
    }
    if (response.status === 429) {
      throw new TelegramRequestError("rate_limit", "rate limited", {
        retryAfterMs: retryAfterFrom(row),
      });
    }
    if (response.status >= 500) {
      throw new TelegramRequestError("server", "telegram is unavailable");
    }
    throw new TelegramRequestError(
      "bad_request",
      safeDescription(row.description) || "telegram refused the media"
    );
  }

  async function fetchMedia(
    mediaInput: ImMediaFetchInput
  ): Promise<ImMediaFetchResult> {
    const row = await request("getFile", { file_id: mediaInput.media.id });
    const filePath =
      typeof record(row.result).file_path === "string"
        ? String(record(row.result).file_path).trim()
        : "";
    if (!filePath || filePath.includes("..")) {
      throw new TelegramRequestError(
        "bad_request",
        "telegram returned no safe file path"
      );
    }
    const encodedPath = filePath
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const signal = combineSignals(
      controller?.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    );
    const response = await sendFetch(
      `${apiBase}/file/bot${token}/${encodedPath}`,
      { signal }
    );
    if (!response.ok) {
      throw new TelegramRequestError(
        response.status >= 500 ? "server" : "bad_request",
        "telegram file download failed"
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponseBody(response, 2_000_000);
    } catch (error) {
      if (error instanceof MediaDownloadLimitError) {
        throw new TelegramRequestError(
          "bad_request",
          "telegram file is too large"
        );
      }
      throw error;
    }
    if (bytes.byteLength === 0) {
      throw new TelegramRequestError(
        "bad_request",
        "telegram file is too large"
      );
    }
    return {
      data: bytes,
      mediaType:
        response.headers.get("content-type")?.split(";")[0]?.trim() ??
        mediaInput.media.mimeType ??
        "application/octet-stream",
      ...(filePath.split("/").pop()
        ? { filename: filePath.split("/").pop()! }
        : {}),
    };
  }

  return {
    platform: "telegram",
    capabilities,
    start: async () => {
      if (loop) return;
      if (!token) {
        health = { state: "needs_login", detail: "bot token is missing" };
        throw new Error("telegram bot token is missing");
      }
      controller = new AbortController();
      health = { state: "starting" };
      loop = pollLoop();
    },
    stop: async () => {
      if (!controller) {
        health = { state: "stopped" };
        return;
      }
      controller.abort();
      await loop?.catch(() => {});
      loop = undefined;
      controller = undefined;
      health = { state: "stopped" };
    },
    health: async () => ({ ...health }),
    send: async (message) => {
      const run = sendChain.then(() => sendMedia(message));
      sendChain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    onInbound: (handler) => {
      inbound = handler;
    },
    fetchMedia,
  };
}

/** Telegram chunks plain text at 4096; the `(n/m)` marker is part of the budget. */
export function chunkTelegramText(
  text: string,
  max = TELEGRAM_MAX_TEXT
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];
  const markerBudget = 10;
  const limit = Math.max(1, max - markerBudget);
  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    let cut = limit;
    const head = rest.slice(0, limit);
    const newline = head.lastIndexOf("\n");
    const space = head.lastIndexOf(" ");
    const candidate = Math.max(newline, space);
    if (candidate > Math.floor(limit * 0.6)) {
      cut = candidate + 1;
    }
    // Never split a surrogate pair.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  if (parts.length <= 1) return parts;
  return parts.map(
    (part, index) => `${part}\n\n(${index + 1}/${parts.length})`
  );
}

function parseUpdate(
  update: unknown,
  accountId: string,
  at: Date
): ImInbound | undefined {
  const row = record(update);
  const message = record(row.message);
  if (!message || !Object.keys(message).length) return undefined;
  const from = record(message.from);
  if (from.is_bot === true) return undefined;
  const chat = record(message.chat);
  const type = chat.type;
  const kind =
    type === "private"
      ? "direct"
      : type === "group" || type === "supergroup"
        ? "group"
        : undefined;
  if (!kind) return undefined;
  const text =
    typeof message.text === "string"
      ? message.text.trim()
      : typeof message.caption === "string"
        ? message.caption.trim()
        : "";
  const media = telegramMedia(message);
  if (!text && media.length === 0) return undefined;
  const chatId = numericId(chat.id);
  const senderId = numericId(from.id);
  if (!chatId || !senderId) return undefined;
  const threadId = numericId(message.message_thread_id);
  const messageId = numericId(message.message_id);
  const updateId = numericId(row.update_id);
  if (messageId === undefined) return undefined;
  const username =
    typeof from.username === "string" ? from.username.trim() : "";
  const title =
    typeof chat.title === "string" && chat.title.trim()
      ? chat.title.trim()
      : kind === "group"
        ? undefined
        : username
          ? `@${username}`
          : "Direct message";
  const seconds = numeric(message.date);
  const receivedAt =
    seconds !== undefined && seconds > 0
      ? new Date(seconds * 1_000).toISOString()
      : at.toISOString();
  return {
    platform: "telegram",
    accountId,
    chat: {
      kind,
      id: chatId,
      ...(threadId ? { threadId } : {}),
      ...(title ? { title: title.slice(0, 200) } : {}),
    },
    sender: {
      id: senderId,
      ...(username ? { name: username.slice(0, 100) } : {}),
    },
    messageId: String(messageId),
    ...(updateId !== undefined ? { updateId: String(updateId) } : {}),
    text: text.slice(0, MAX_TEXT),
    ...(media.length ? { media } : {}),
    replyTo: String(messageId),
    receivedAt,
  };
}

function telegramMedia(message: Record<string, unknown>): ImMediaRef[] {
  if (Array.isArray(message.photo)) {
    const photos = message.photo.flatMap((entry) => {
      const row = record(entry);
      const id = typeof row.file_id === "string" ? row.file_id : "";
      return id ? [row] : [];
    });
    const photo = photos.some((row) => numeric(row.file_size) !== undefined)
      ? photos.sort(
          (left, right) =>
            (numeric(right.file_size) ?? 0) - (numeric(left.file_size) ?? 0)
        )[0]
      : photos.at(-1);
    const id = typeof photo?.file_id === "string" ? photo.file_id : "";
    if (id) {
      return [
        {
          kind: "image",
          id,
          mimeType: "image/jpeg",
          ...(numeric(photo?.file_size) !== undefined
            ? { size: numeric(photo?.file_size) }
            : {}),
        },
      ];
    }
  }
  for (const [key, kind] of [
    ["document", "file"],
    ["audio", "audio"],
    ["voice", "audio"],
    ["video", "video"],
    ["video_note", "video"],
    ["animation", "video"],
    ["sticker", "image"],
  ] as const) {
    const row = record(message[key]);
    const id = typeof row.file_id === "string" ? row.file_id : "";
    if (!id) continue;
    const mime =
      typeof row.mime_type === "string"
        ? row.mime_type
        : key === "sticker"
          ? "image/webp"
          : undefined;
    return [
      {
        kind,
        id,
        ...(mime ? { mimeType: mime } : {}),
        ...(numeric(row.file_size) !== undefined
          ? { size: numeric(row.file_size) }
          : {}),
        ...(typeof row.file_name === "string" && row.file_name.trim()
          ? { filename: row.file_name.trim().slice(0, 120) }
          : {}),
      },
    ];
  }
  return [];
}

function classificationFor(error: unknown): ImSendResult {
  if (!(error instanceof TelegramRequestError)) {
    return { status: "unknown", reason: "telegram request failed" };
  }
  switch (error.kind) {
    case "network":
      return { status: "unknown", reason: "telegram response was lost" };
    case "rate_limit":
      return {
        status: "retry",
        reason: "telegram rate limited the message",
        ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    case "server":
      return { status: "retry", reason: "telegram is temporarily unavailable" };
    case "unauthorized":
      return { status: "discard", reason: "telegram rejected the bot token" };
    case "conflict":
    case "bad_request":
      return {
        status: "discard",
        reason: error.message.slice(0, 200) || "telegram refused the message",
      };
  }
}

function combineSignals(
  stop: AbortSignal | undefined,
  timeout: AbortSignal
): AbortSignal {
  return stop ? AbortSignal.any([stop, timeout]) : timeout;
}

function safeDescription(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").slice(0, 200)
    : "";
}

function retryAfterFrom(row: Record<string, unknown>): number | undefined {
  const parameters = record(row.parameters);
  const seconds = numeric(parameters.retry_after);
  if (seconds === undefined) return undefined;
  return Math.max(1_000, Math.min(seconds * 1_000, 5 * 60_000));
}

function parseOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function numericId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms)
    );
    timer.unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
