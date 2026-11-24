import { createHash } from "node:crypto";
import type {
  ImAccount,
  ImAdapter,
  ImAdapterCredentials,
  ImAdapterFactory,
  ImCapabilities,
  ImHealth,
  ImInbound,
  ImSendInput,
  ImSendResult,
} from "../../agent/im/types.ts";

export const IMESSAGE_MAX_TEXT = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 20_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
const MAX_POLL_MESSAGES = 50;

type ImessageErrorKind =
  | "offline"
  | "timeout"
  | "unauthorized"
  | "rate_limit"
  | "server"
  | "bad_request";

class ImessageBridgeError extends Error {
  readonly kind: ImessageErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: ImessageErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = "ImessageBridgeError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** A cursor belongs to one BlueBubbles server; a different server has a different message table. */
export function imessageCursorIdentity(
  credentials: ImAdapterCredentials
): string | undefined {
  const base = imessageBaseUrl(credentials.baseUrl ?? "");
  return base
    ? createHash("sha256").update(base).digest("hex").slice(0, 16)
    : undefined;
}

export function validateImessageCredentials(
  credentials: ImAdapterCredentials
): string | undefined {
  if (!imessageBaseUrl(credentials.baseUrl ?? "")) {
    return "baseUrl must be an http or https URL";
  }
  if (!credentials.password?.trim()) {
    return "missing credential: password";
  }
  return undefined;
}

/**
 * iMessage through a BlueBubbles server on a Mac that stays online. BlueBubbles owns the Apple ID,
 * Full Disk Access and Messages.app integration; Core only polls its REST API and sends text. Text is
 * the only implemented content, and an offline Mac is retried by the gateway's outbox rather than
 * silently dropping a notice. The webhook/imsg bridge can be added behind the same adapter seam later.
 */
export function createImessageImAdapter(input: {
  account: ImAccount;
  credentials: ImAdapterCredentials;
  cursor?: string;
  onCursor(cursor: string): void;
  onError?(message: string): void;
  fetch?: typeof fetch;
  now?: () => Date;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}): ImAdapter {
  const now = input.now ?? (() => new Date());
  const sendFetch = input.fetch ?? fetch;
  const baseUrl = imessageBaseUrl(input.credentials.baseUrl ?? "");
  const password = input.credentials.password?.trim() ?? "";
  const pollIntervalMs = Math.max(
    1,
    input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  );
  const requestTimeoutMs =
    input.requestTimeoutMs !== undefined
      ? Math.max(1, input.requestTimeoutMs)
      : REQUEST_TIMEOUT_MS;
  const capabilities: ImCapabilities = {
    proactive: true,
    replyOnly: false,
    recall: false,
    // BlueBubbles can send media, but Core only implements text here.
    media: false,
    maxTextLength: IMESSAGE_MAX_TEXT,
    markdown: false,
    threads: false,
    typing: false,
  };
  let health: ImHealth = { state: "stopped" };
  let cursor = parseCursor(input.cursor);
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let inbound: ((message: ImInbound) => Promise<void>) | undefined;
  let inboundChain: Promise<void> = Promise.resolve();

  function setHealth(next: ImHealth): void {
    health = next;
    if (next.state === "error" && next.detail) input.onError?.(next.detail);
    if (next.state === "needs_login" && next.detail) {
      input.onError?.(next.detail);
    }
  }

  async function requestJson(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<{ response: Response; body: Record<string, unknown> }> {
    if (!baseUrl || !password) {
      throw new ImessageBridgeError(
        "unauthorized",
        "BlueBubbles URL or password is missing"
      );
    }
    const url = new URL(`${baseUrl}${path}`);
    const signal = controller
      ? AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(requestTimeoutMs),
        ])
      : AbortSignal.timeout(requestTimeoutMs);
    let response: Response;
    try {
      response = await sendFetch(url, {
        method,
        headers: {
          authorization: password,
          "content-type": "application/json",
        },
        redirect: "error",
        signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new ImessageBridgeError("offline", "iMessage bridge stopped");
      }
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new ImessageBridgeError(
          "timeout",
          "BlueBubbles request timed out"
        );
      }
      throw new ImessageBridgeError("offline", "BlueBubbles is unreachable");
    }
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // A non-JSON response still carries a status; the caller classifies it.
    }
    return { response, body: payload };
  }

  async function query(
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    try {
      const { response, body: payload } = await requestJson(
        "POST",
        "/api/v1/message/query",
        body
      );
      if (!response.ok) {
        throw classify(response, payload);
      }
      return records(payload.data);
    } catch (error) {
      if (
        error instanceof ImessageBridgeError &&
        error.kind === "bad_request" &&
        error.status === 404
      ) {
        // Older BlueBubbles servers expose only the GET listing.
        const url = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
          if (typeof value === "string" || typeof value === "number") {
            url.set(key, String(value));
          }
        }
        const { response, body: payload } = await requestJson(
          "GET",
          `/api/v1/message?${url.toString()}`
        );
        if (!response.ok) throw classify(response, payload);
        return records(payload.data);
      }
      throw error;
    }
  }

  function baseline(): Promise<number> {
    return query({ limit: 1, sort: "DESC" }).then((rows) => {
      const created = rows
        .map((row) => dateOf(row))
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => right - left)[0];
      return created ?? now().getTime();
    });
  }

  async function pollOnce(): Promise<void> {
    if (!baseUrl || !password) {
      throw new ImessageBridgeError(
        "unauthorized",
        "BlueBubbles URL or password is missing"
      );
    }
    if (cursor === undefined) {
      // The first read is a baseline: messages already in chat.db are history, not events.
      const newest = await baseline();
      cursor = newest;
      input.onCursor(String(cursor));
      return;
    }
    const rows = await query({
      after: cursor,
      limit: MAX_POLL_MESSAGES,
      sort: "ASC",
      with: ["chats"],
    });
    const roundStart = cursor;
    for (const row of rows) {
      const created = dateOf(row);
      if (created === undefined || created < roundStart) continue;
      const message = parseMessage(row, input.account.id, now());
      if (message && inbound) {
        inboundChain = inboundChain
          .then(() => inbound!(message))
          .catch(() => {
            // The gateway records the failure; one poison message must not stop polling.
          });
      }
      if (created > cursor) {
        cursor = created;
        input.onCursor(String(cursor));
      }
    }
  }

  async function pollLoop(active: AbortController): Promise<void> {
    let backoff = 0;
    while (!active.signal.aborted) {
      try {
        await pollOnce();
        if (active.signal.aborted) return;
        backoff = 0;
        setHealth({ state: "connected", since: now().toISOString() });
      } catch (error) {
        if (active.signal.aborted) return;
        const failure =
          error instanceof ImessageBridgeError
            ? error
            : new ImessageBridgeError("offline", "BlueBubbles polling failed");
        if (failure.kind === "unauthorized") {
          setHealth({
            state: "needs_login",
            detail: failure.message,
            code: "invalid_credentials",
            since: now().toISOString(),
          });
          return;
        }
        setHealth({
          state: "error",
          detail: failure.message,
          since: now().toISOString(),
        });
        const wait = BACKOFF_MS[Math.min(backoff, BACKOFF_MS.length - 1)]!;
        backoff += 1;
        await sleep(wait, active.signal);
        continue;
      }
      await sleep(pollIntervalMs, active.signal);
    }
  }

  return {
    platform: "imessage",
    capabilities,
    async start() {
      if (loop) return;
      if (!baseUrl || !password) {
        setHealth({
          state: "needs_login",
          detail: "BlueBubbles URL or password is missing",
          code: "invalid_credentials",
        });
        return;
      }
      controller = new AbortController();
      setHealth({ state: "starting", since: now().toISOString() });
      loop = pollLoop(controller);
    },
    async stop() {
      controller?.abort();
      await loop?.catch(() => undefined);
      loop = undefined;
      controller = undefined;
      setHealth({ state: "stopped" });
    },
    async health() {
      return { ...health };
    },
    async send(message: ImSendInput): Promise<ImSendResult> {
      if (!baseUrl || !password) {
        return { status: "discard", reason: "credentials_missing" };
      }
      const text = message.text.trim();
      if (!text) return { status: "discard", reason: "empty_text" };
      try {
        const { response, body } = await requestJson(
          "POST",
          "/api/v1/message/text",
          {
            chatGuid: message.chat.id,
            tempGuid: `thebe-${createHash("sha256")
              .update(message.idempotencyKey)
              .digest("hex")
              .slice(0, 32)}`,
            message: truncateImessageText(text),
            method: "apple-script",
          }
        );
        const status = numeric(body.status);
        if (!response.ok || (status !== undefined && status >= 400)) {
          throw classify(response, body);
        }
        if (status !== undefined && status !== 200) {
          return {
            status: "discard",
            reason:
              typeof body.message === "string"
                ? body.message.slice(0, 200)
                : "BlueBubbles refused the message",
          };
        }
        const data = record(body.data);
        setHealth({ state: "connected", since: now().toISOString() });
        return {
          status: "sent",
          ...(typeof data.guid === "string"
            ? { platformMessageId: data.guid }
            : {}),
        };
      } catch (error) {
        if (!(error instanceof ImessageBridgeError)) {
          return { status: "unknown", reason: "BlueBubbles send failed" };
        }
        if (error.kind === "timeout") {
          return {
            status: "unknown",
            reason: "BlueBubbles response was lost",
          };
        }
        if (error.kind === "offline") {
          return {
            status: "retry",
            reason: "BlueBubbles is unreachable",
          };
        }
        if (error.kind === "rate_limit") {
          return {
            status: "retry",
            reason: "BlueBubbles rate limited the message",
            ...(error.retryAfterMs !== undefined
              ? { retryAfterMs: error.retryAfterMs }
              : {}),
          };
        }
        if (error.kind === "unauthorized") {
          return {
            status: "discard",
            reason: "BlueBubbles rejected the request",
          };
        }
        if (error.kind === "server") {
          return { status: "unknown", reason: "BlueBubbles response was lost" };
        }
        return { status: "discard", reason: error.message };
      }
    },
    onInbound(handler) {
      inbound = handler;
    },
  };
}

export function createImessageFactory(
  env: NodeJS.ProcessEnv = process.env
): ImAdapterFactory {
  const baseUrl =
    env.THEBE_IMESSAGE_BASE_URL?.trim() ||
    env.THEBE_BLUEBUBBLES_URL?.trim() ||
    undefined;
  const password =
    env.THEBE_IMESSAGE_PASSWORD?.trim() ||
    env.THEBE_BLUEBUBBLES_PASSWORD?.trim() ||
    undefined;
  return {
    platform: "imessage",
    credentials: [
      { key: "baseUrl", label: "BlueBubbles server URL" },
      { key: "password", label: "Server password", secret: true },
    ],
    validateCredentials: validateImessageCredentials,
    cursorIdentity: imessageCursorIdentity,
    create: (createInput) =>
      createImessageImAdapter({
        account: createInput.account,
        credentials: {
          ...createInput.credentials,
          ...(createInput.credentials.baseUrl?.trim() || !baseUrl
            ? {}
            : { baseUrl }),
          ...(createInput.credentials.password?.trim() || !password
            ? {}
            : { password: password }),
        },
        ...(createInput.cursor ? { cursor: createInput.cursor } : {}),
        onCursor: createInput.onCursor,
        ...(createInput.onError ? { onError: createInput.onError } : {}),
        ...(createInput.fetch ? { fetch: createInput.fetch } : {}),
        ...(createInput.now ? { now: createInput.now } : {}),
      }),
  };
}

export function truncateImessageText(
  text: string,
  max = IMESSAGE_MAX_TEXT
): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

export function imessageBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (url.username || url.password) return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

function parseMessage(
  value: Record<string, unknown>,
  accountId: string,
  at: Date
): ImInbound | undefined {
  if (
    value.isFromMe === true ||
    value.is_from_me === true ||
    value.isSystemMessage === true ||
    value.is_system_message === true
  ) {
    return undefined;
  }
  const associated = value.associatedMessageGuid ?? value.associatedMessageType;
  if (associated !== undefined && associated !== null && associated !== "") {
    // Tapbacks and reactions are represented as messages by BlueBubbles.
    return undefined;
  }
  const text = stringValue(value.text)?.trim() ?? "";
  if (!text) return undefined;
  const guid = stringValue(value.guid);
  if (!guid) return undefined;
  const chat = record(records(value.chats)[0]);
  const chatGuid =
    stringValue(chat.guid) ??
    stringValue(value.chatGuid) ??
    stringValue(value.chat_guid);
  const handle = record(value.handle);
  const senderId =
    stringValue(handle.address) ??
    stringValue(chat.chatIdentifier) ??
    stringValue(chat.chat_identifier);
  if (!chatGuid || !senderId) return undefined;
  const kind = chatGuid.includes(";+;") ? "group" : "direct";
  const title =
    stringValue(chat.displayName) ??
    stringValue(chat.chatIdentifier) ??
    stringValue(chat.chat_identifier);
  const created = dateOf(value);
  return {
    platform: "imessage",
    accountId,
    chat: {
      kind,
      id: chatGuid,
      ...(title ? { title: title.slice(0, 200) } : {}),
    },
    sender: { id: senderId, name: senderId.slice(0, 100) },
    messageId: guid,
    text: text.slice(0, 16_000),
    replyTo: guid,
    receivedAt:
      created !== undefined
        ? new Date(created).toISOString()
        : at.toISOString(),
  };
}

function classify(
  response: Response,
  body: Record<string, unknown>
): ImessageBridgeError {
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.slice(0, 200)
      : `BlueBubbles returned HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    return new ImessageBridgeError("unauthorized", message, {
      status: response.status,
    });
  }
  if (response.status === 429) {
    return new ImessageBridgeError("rate_limit", message, {
      status: 429,
      ...(retryAfter(response, body) !== undefined
        ? { retryAfterMs: retryAfter(response, body) }
        : {}),
    });
  }
  if (response.status >= 500) {
    return new ImessageBridgeError("server", message, {
      status: response.status,
    });
  }
  return new ImessageBridgeError("bad_request", message, {
    status: response.status,
  });
}

function retryAfter(
  response: Response,
  body: Record<string, unknown>
): number | undefined {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const seconds = numeric(body.retry_after) ?? numeric(body.retryAfter);
  return seconds !== undefined && seconds >= 0 ? seconds * 1_000 : undefined;
}

function dateOf(value: Record<string, unknown>): number | undefined {
  const raw = numeric(value.dateCreated) ?? numeric(value.date_created);
  if (raw === undefined || raw <= 0) return undefined;
  // BlueBubbles uses milliseconds; a few older payloads use seconds.
  return raw < 1_000_000_000_000 ? raw * 1_000 : raw;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCursor(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
