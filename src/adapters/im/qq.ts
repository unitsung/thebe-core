import { createHash } from "node:crypto";
import type {
  ImAccount,
  ImAdapter,
  ImAdapterCredentials,
  ImAdapterFactory,
  ImCapabilities,
  ImChat,
  ImHealth,
  ImInbound,
  ImMediaRef,
  ImSendInput,
  ImSendResult,
} from "../../agent/im/types.ts";

export const QQ_MAX_TEXT = 2_000;
export const QQ_C2C_REPLY_WINDOW_MS = 60 * 60_000;
export const QQ_GROUP_REPLY_WINDOW_MS = 5 * 60_000;
export const QQ_C2C_MAX_REPLIES = 4;
export const QQ_GROUP_MAX_REPLIES = 5;

const DEFAULT_API_BASE = "https://api.bot.qq.com";
const DEFAULT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const REQUEST_TIMEOUT_MS = 20_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
const INTENTS_GROUP_AND_C2C = 1 << 25;
const MAX_REPLY_ENTRIES = 1_000;
const MAX_TEXT = 16_000;

type QqSocketMessage = { data: unknown };
type QqSocketClose = { code?: number; reason?: string };

/** The narrow WebSocket shape the gateway uses; tests inject a fake implementation. */
export type QqWebSocket = {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: QqSocketMessage) => void) | null;
  onclose: ((event: QqSocketClose) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type QqSocketFactory = (url: string) => QqWebSocket;

type QqErrorKind =
  | "network"
  | "unauthorized"
  | "rate_limit"
  | "server"
  | "bad_request"
  | "window_closed";

class QqRequestError extends Error {
  readonly kind: QqErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: QqErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = "QqRequestError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** A cursor belongs to one bot application; a changed AppID must not resume another bot's window. */
export function qqCursorIdentity(
  credentials: ImAdapterCredentials
): string | undefined {
  const appId = credentials.appId?.trim();
  return appId
    ? createHash("sha256").update(appId).digest("hex").slice(0, 16)
    : undefined;
}

export function validateQqCredentials(
  credentials: ImAdapterCredentials
): string | undefined {
  if (!credentials.appId?.trim()) return "missing credential: appId";
  if (!credentials.clientSecret?.trim()) {
    return "missing credential: clientSecret";
  }
  if (/\s/.test(credentials.appId.trim())) {
    return "QQ AppID must not contain spaces";
  }
  return undefined;
}

export function qqReplyWindowMs(kind: ImChat["kind"]): number {
  return kind === "group" ? QQ_GROUP_REPLY_WINDOW_MS : QQ_C2C_REPLY_WINDOW_MS;
}

export function qqMaxReplies(kind: ImChat["kind"]): number {
  return kind === "group" ? QQ_GROUP_MAX_REPLIES : QQ_C2C_MAX_REPLIES;
}

/**
 * QQ's official bot OpenAPI v2. The gateway is a WebSocket whose IDENTIFY carries the application
 * access token; outbound messages are passive replies to the inbound `msg_id`, because QQ's proactive
 * push is rate-limited and can be disabled per recipient. The gateway deduplicates redelivered events;
 * this adapter keeps a bounded per-message window so a chunked reply gets a fresh `msg_seq`.
 */
export function createQqImAdapter(input: {
  account: ImAccount;
  credentials: ImAdapterCredentials;
  cursor?: string;
  onCursor(cursor: string): void;
  onError?(message: string): void;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Tests and self-hosted proxies point these at a local fake. */
  apiBase?: string;
  tokenUrl?: string;
  gatewayUrl?: string;
  socketFactory?: QqSocketFactory;
}): ImAdapter {
  const now = input.now ?? (() => new Date());
  const sendFetch = input.fetch ?? fetch;
  const apiBase = (
    input.apiBase ??
    process.env.THEBE_QQ_API_BASE ??
    DEFAULT_API_BASE
  ).replace(/\/+$/, "");
  const tokenUrl =
    input.tokenUrl ?? process.env.THEBE_QQ_TOKEN_URL ?? DEFAULT_TOKEN_URL;
  const appId = input.credentials.appId?.trim() ?? "";
  const clientSecret = input.credentials.clientSecret?.trim() ?? "";
  const socketFactory = input.socketFactory ?? defaultSocketFactory;
  const capabilities: ImCapabilities = {
    proactive: false,
    replyOnly: true,
    // The group window is the conservative value; a C2C chat has a longer one.
    replyWindowMs: QQ_GROUP_REPLY_WINDOW_MS,
    maxMessagesPerWindow: QQ_C2C_MAX_REPLIES,
    recall: false,
    // Text is implemented; QQ media needs a separate upload.
    media: false,
    maxTextLength: QQ_MAX_TEXT,
    markdown: false,
    threads: false,
    typing: false,
  };
  let health: ImHealth = { state: "stopped" };
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let socket: QqWebSocket | undefined;
  let inbound: ((message: ImInbound) => Promise<void>) | undefined;
  let inboundChain: Promise<void> = Promise.resolve();
  let sessionId: string | null = null;
  let lastSequence: number | null = null;
  let accessToken: string | undefined;
  let tokenExpiresAt = 0;
  let tokenFlight: Promise<string> | undefined;
  let sendChain: Promise<unknown> = Promise.resolve();
  const replyWindows = new Map<
    string,
    { receivedAt: number; kind: ImChat["kind"]; nextSeq: number }
  >();

  function setHealth(next: ImHealth): void {
    health = next;
    if (next.state === "error" && next.detail) input.onError?.(next.detail);
    if (next.state === "needs_login" && next.detail) {
      input.onError?.(next.detail);
    }
  }

  function endpoint(path: string): string {
    return `${apiBase}${path}`;
  }

  async function requestJson(
    url: string,
    init: RequestInit,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<{ response: Response; body: Record<string, unknown> }> {
    const signal = controller
      ? AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await sendFetch(url, { ...init, signal });
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new QqRequestError("network", "QQ request stopped");
      }
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new QqRequestError("network", "QQ request timed out");
      }
      throw new QqRequestError("network", "QQ request failed");
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // A non-JSON body carries no usable detail; the HTTP status still classifies it.
    }
    return { response, body };
  }

  async function getAccessToken(force = false): Promise<string> {
    if (!force && accessToken && now().getTime() < tokenExpiresAt - 60_000) {
      return accessToken;
    }
    if (tokenFlight) return tokenFlight;
    tokenFlight = (async () => {
      if (!appId || !clientSecret) {
        throw new QqRequestError(
          "unauthorized",
          "QQ AppID or AppSecret is missing"
        );
      }
      const { response, body } = await requestJson(
        tokenUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appId, clientSecret }),
        },
        20_000
      );
      const code = numeric(body.code);
      const token =
        typeof body.access_token === "string" ? body.access_token.trim() : "";
      if (!response.ok || (code !== undefined && code !== 0) || !token) {
        const message =
          typeof body.message === "string"
            ? body.message.slice(0, 200)
            : `QQ token request returned HTTP ${response.status}`;
        const invalid = code === 10004 || code === 100007 || code === 100016;
        throw new QqRequestError(
          invalid || response.status === 401 || response.status === 403
            ? "unauthorized"
            : response.status === 429
              ? "rate_limit"
              : response.status >= 500
                ? "server"
                : "bad_request",
          invalid ? "QQ rejected the AppID or AppSecret" : message,
          {
            status: response.status,
            ...(retryAfterFrom(response, body) !== undefined
              ? { retryAfterMs: retryAfterFrom(response, body) }
              : {}),
          }
        );
      }
      const expiresIn = numeric(body.expires_in) ?? 7_200;
      accessToken = token;
      tokenExpiresAt = now().getTime() + Math.max(60, expiresIn) * 1_000;
      return token;
    })().finally(() => {
      tokenFlight = undefined;
    });
    return tokenFlight;
  }

  async function apiRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const token = await getAccessToken();
    const { response, body: payload } = await requestJson(endpoint(path), {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const code = errorCode(payload);
    if (!response.ok || (code !== undefined && code !== 0)) {
      throw classifyApiError(response, payload, code);
    }
    return payload;
  }

  async function getGatewayUrl(): Promise<string> {
    if (input.gatewayUrl) return input.gatewayUrl;
    let failure: unknown;
    for (const path of ["/gateway/bot", "/gateway"]) {
      try {
        const payload = await apiRequest("GET", path);
        const url = typeof payload.url === "string" ? payload.url.trim() : "";
        if (isWebSocketUrl(url)) return url;
        failure = new QqRequestError(
          "server",
          "QQ gateway returned no WebSocket URL"
        );
      } catch (error) {
        failure = error;
        if (
          !(error instanceof QqRequestError) ||
          (error.kind !== "bad_request" && error.kind !== "server")
        ) {
          throw error;
        }
      }
    }
    throw failure instanceof QqRequestError
      ? failure
      : new QqRequestError("server", "QQ gateway is unavailable");
  }

  function sendGateway(payload: Record<string, unknown>): void {
    if (!socket) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      try {
        socket.close(4000, "send failed");
      } catch {
        // The close handler reports the disconnect.
      }
    }
  }

  function startHeartbeat(socket: QqWebSocket, intervalMs: number): () => void {
    const timer = setInterval(
      () => {
        sendGateway({ op: 1, d: lastSequence });
      },
      Math.max(1_000, intervalMs)
    );
    timer.unref?.();
    return () => clearInterval(timer);
  }

  function connect(active: AbortController): Promise<{ ready: boolean }> {
    return new Promise<{ ready: boolean }>((resolve, reject) => {
      let settled = false;
      let ready = false;
      let current: QqWebSocket | undefined;
      let clearHeartbeat: (() => void) | undefined;
      const finish = (error?: QqRequestError): void => {
        if (settled) return;
        settled = true;
        clearHeartbeat?.();
        clearHeartbeat = undefined;
        socket = undefined;
        if (current) {
          current.onmessage = null;
          current.onclose = null;
          current.onerror = null;
          current.onopen = null;
        }
        if (error) reject(error);
        else resolve({ ready });
      };

      void (async () => {
        try {
          const token = await getAccessToken();
          const url = await getGatewayUrl();
          if (active.signal.aborted) {
            finish(new QqRequestError("network", "QQ connection stopped"));
            return;
          }
          current = socketFactory(url);
          socket = current;
          current.onopen = () => {
            if (active.signal.aborted) current?.close(1000, "stopped");
          };
          current.onerror = () => {
            if (!ready) {
              finish(
                new QqRequestError("network", "QQ gateway connection failed")
              );
            }
          };
          current.onclose = (event) => {
            if (active.signal.aborted) {
              finish();
              return;
            }
            if (!ready) {
              const unavailable = event?.code === 4914 || event?.code === 4915;
              finish(
                new QqRequestError(
                  unavailable ? "unauthorized" : "network",
                  unavailable
                    ? "QQ bot is offline or unavailable"
                    : "QQ gateway closed before READY"
                )
              );
              return;
            }
            finish();
          };
          current.onmessage = (event) => {
            const payload = parsePayload(event?.data);
            if (!payload) return;
            const op = numeric(payload.op);
            if (op === 10) {
              const interval =
                numeric(record(payload.d).heartbeat_interval) ?? 45_000;
              clearHeartbeat?.();
              clearHeartbeat = startHeartbeat(current!, interval);
              if (sessionId && lastSequence !== null) {
                sendGateway({
                  op: 6,
                  d: {
                    token: `QQBot ${token}`,
                    session_id: sessionId,
                    seq: lastSequence,
                  },
                });
              } else {
                sendGateway({
                  op: 2,
                  d: {
                    token: `QQBot ${token}`,
                    intents: INTENTS_GROUP_AND_C2C,
                    shard: [0, 1],
                    properties: {
                      $os: process.platform,
                      $browser: "thebe",
                      $device: "thebe",
                    },
                  },
                });
              }
              return;
            }
            if (op === 0) {
              const sequence = numeric(payload.s);
              if (sequence !== undefined) lastSequence = sequence;
              const type = typeof payload.t === "string" ? payload.t : "";
              if (type === "READY") {
                const readyData = record(payload.d);
                sessionId =
                  typeof readyData.session_id === "string"
                    ? readyData.session_id
                    : null;
                ready = true;
                setHealth({ state: "connected", since: now().toISOString() });
                return;
              }
              if (type === "RESUMED") {
                ready = true;
                setHealth({ state: "connected", since: now().toISOString() });
                return;
              }
              if (
                type === "C2C_MESSAGE_CREATE" ||
                type === "GROUP_AT_MESSAGE_CREATE"
              ) {
                const message = parseMessage(
                  type,
                  payload.d,
                  input.account.id,
                  now()
                );
                if (!message) return;
                rememberWindow(message);
                const handler = inbound;
                if (!handler) return;
                inboundChain = inboundChain
                  .then(() => handler(message))
                  .catch(() => {
                    // The gateway records the failure; one poison message must not stop the socket.
                  });
              }
              return;
            }
            if (op === 11) return;
            if (op === 7) {
              // Keep the session and sequence so the next connection resumes.
              try {
                current?.close(4000, "reconnect requested");
              } catch {
                finish();
              }
              return;
            }
            if (op === 9) {
              sessionId = null;
              lastSequence = null;
              try {
                current?.close(4000, "invalid session");
              } catch {
                finish();
              }
            }
          };
        } catch (error) {
          const failure =
            error instanceof QqRequestError
              ? error
              : new QqRequestError("network", "QQ connection failed");
          finish(failure);
        }
      })();
    });
  }

  async function runLoop(active: AbortController): Promise<void> {
    let backoff = 0;
    while (!active.signal.aborted) {
      try {
        const result = await connect(active);
        if (active.signal.aborted) return;
        backoff = result.ready ? 0 : backoff + 1;
        setHealth({
          state: "error",
          detail: "QQ gateway disconnected; reconnecting",
          since: now().toISOString(),
        });
        await sleep(backoff === 0 ? 1_000 : BACKOFF_MS[0]!, active.signal);
      } catch (error) {
        if (active.signal.aborted) return;
        const failure =
          error instanceof QqRequestError
            ? error
            : new QqRequestError("network", "QQ gateway failed");
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
      }
    }
  }

  function rememberWindow(message: ImInbound): void {
    const key = message.replyTo ?? message.messageId;
    // A redelivered event must not reset the sequence already used by a reply.
    if (replyWindows.has(key)) return;
    replyWindows.set(key, {
      receivedAt: Date.parse(message.receivedAt) || now().getTime(),
      kind: message.chat.kind,
      nextSeq: 1,
    });
    if (replyWindows.size <= MAX_REPLY_ENTRIES) return;
    const oldest = replyWindows.keys().next().value;
    if (oldest !== undefined) replyWindows.delete(oldest);
  }

  function claimReply(
    replyTo: string,
    kind: ImChat["kind"]
  ): { seq: number; remaining: number } | undefined {
    let entry = replyWindows.get(replyTo);
    if (!entry) {
      // A reply to a message seen before a restart still gets one attempt; the platform
      // rejects it as expired if the window is gone. Tracking it keeps a second chunked
      // reply from reusing `msg_seq = 1`.
      entry = { receivedAt: now().getTime(), kind, nextSeq: 1 };
      replyWindows.set(replyTo, entry);
    }
    if (now().getTime() - entry.receivedAt > qqReplyWindowMs(kind)) {
      replyWindows.delete(replyTo);
      return undefined;
    }
    const max = qqMaxReplies(kind);
    if (entry.nextSeq > max) return undefined;
    const claimed = { seq: entry.nextSeq, remaining: max - entry.nextSeq + 1 };
    entry.nextSeq += 1;
    return claimed;
  }

  async function sendChunks(message: ImSendInput): Promise<ImSendResult> {
    if (!appId || !clientSecret) {
      return { status: "discard", reason: "credentials_missing" };
    }
    if (message.mode === "proactive") {
      return { status: "discard", reason: "proactive_not_supported" };
    }
    if (!message.replyTo) {
      return { status: "discard", reason: "reply_window_required" };
    }
    if (controller?.signal.aborted) {
      return { status: "discard", reason: "channel_stopped" };
    }
    const claimed = claimReply(message.replyTo, message.chat.kind);
    if (!claimed) return { status: "discard", reason: "window_closed" };
    const chunks = chunkQqText(message.text, QQ_MAX_TEXT, claimed.remaining);
    if (chunks.length === 0) return { status: "discard", reason: "empty_text" };
    const path =
      message.chat.kind === "group"
        ? `/v2/groups/${encodeURIComponent(message.chat.id)}/messages`
        : `/v2/users/${encodeURIComponent(message.chat.id)}/messages`;
    let lastId: string | undefined;
    for (let index = 0; index < chunks.length; index += 1) {
      try {
        const reply = await apiRequest("POST", path, {
          content: chunks[index]!,
          msg_type: 0,
          msg_id: message.replyTo,
          msg_seq: claimed.seq + index,
        });
        const id = typeof reply.id === "string" ? reply.id : undefined;
        if (id) lastId = id;
        setHealth({ state: "connected", since: now().toISOString() });
      } catch (error) {
        const failure =
          error instanceof QqRequestError
            ? error
            : new QqRequestError("network", "QQ send failed");
        if (failure.kind === "window_closed") {
          replyWindows.delete(message.replyTo);
          return { status: "discard", reason: "window_closed" };
        }
        return classificationFor(failure, index > 0);
      }
    }
    return {
      status: "sent",
      ...(lastId ? { platformMessageId: lastId } : {}),
    };
  }

  return {
    platform: "qq",
    capabilities,
    async start() {
      if (loop) return;
      if (!appId || !clientSecret) {
        setHealth({
          state: "needs_login",
          detail: "QQ AppID or AppSecret is missing",
          code: "invalid_credentials",
        });
        return;
      }
      controller = new AbortController();
      setHealth({ state: "starting", since: now().toISOString() });
      loop = runLoop(controller);
    },
    async stop() {
      controller?.abort();
      try {
        socket?.close(1000, "stopped");
      } catch {
        // The adapter is already closing.
      }
      await loop?.catch(() => undefined);
      loop = undefined;
      controller = undefined;
      socket = undefined;
      setHealth({ state: "stopped" });
    },
    async health() {
      return { ...health };
    },
    async send(message) {
      const run = sendChain.then(() => sendChunks(message));
      sendChain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    onInbound(handler) {
      inbound = handler;
    },
    replyWindowMsFor(chat) {
      return qqReplyWindowMs(chat.kind);
    },
    canSendProactively() {
      return false;
    },
  };
}

export function createQqFactory(
  env: NodeJS.ProcessEnv = process.env
): ImAdapterFactory {
  const apiBase = env.THEBE_QQ_API_BASE?.trim() || undefined;
  const tokenUrl = env.THEBE_QQ_TOKEN_URL?.trim() || undefined;
  const gatewayUrl = env.THEBE_QQ_GATEWAY_URL?.trim() || undefined;
  return {
    platform: "qq",
    credentials: [
      { key: "appId", label: "AppID" },
      { key: "clientSecret", label: "AppSecret", secret: true },
    ],
    validateCredentials: validateQqCredentials,
    cursorIdentity: qqCursorIdentity,
    create: (createInput) =>
      createQqImAdapter({
        account: createInput.account,
        credentials: createInput.credentials,
        ...(createInput.cursor ? { cursor: createInput.cursor } : {}),
        onCursor: createInput.onCursor,
        ...(createInput.onError ? { onError: createInput.onError } : {}),
        ...(createInput.fetch ? { fetch: createInput.fetch } : {}),
        ...(createInput.now ? { now: createInput.now } : {}),
        ...(apiBase ? { apiBase } : {}),
        ...(tokenUrl ? { tokenUrl } : {}),
        ...(gatewayUrl ? { gatewayUrl } : {}),
      }),
  };
}

/** QQ accepts plain text; chunks keep the `(n/m)` marker inside the platform limit. */
export function chunkQqText(
  text: string,
  max = QQ_MAX_TEXT,
  maxParts = QQ_C2C_MAX_REPLIES
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (maxParts <= 0) return [];
  if (trimmed.length <= max && maxParts >= 1) return [trimmed];
  const markerBudget = 12;
  const limit = Math.max(1, max - markerBudget);
  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > limit && parts.length < maxParts - 1) {
    let cut = limit;
    const head = rest.slice(0, limit);
    const newline = head.lastIndexOf("\n");
    const space = head.lastIndexOf(" ");
    const candidate = Math.max(newline, space);
    if (candidate > Math.floor(limit * 0.6)) cut = candidate + 1;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) {
    if (rest.length > limit) {
      rest = `${rest.slice(0, Math.max(0, limit - 1))}…`;
    }
    parts.push(rest);
  }
  if (parts.length <= 1) return parts;
  return parts.map(
    (part, index) => `${part}\n\n(${index + 1}/${parts.length})`
  );
}

function parseMessage(
  type: string,
  value: unknown,
  accountId: string,
  at: Date
): ImInbound | undefined {
  const row = record(value);
  const author = record(row.author);
  if (author.bot === true) return undefined;
  const messageId = stringValue(row.id);
  if (!messageId) return undefined;
  const text = stringValue(row.content)?.trim() ?? "";
  const attachments = mediaOf(row.attachments);
  if (!text && attachments.length === 0) return undefined;
  const timestamp = stringValue(row.timestamp);
  const parsedTimestamp = timestamp ? Date.parse(timestamp) : Number.NaN;
  const receivedAt = Number.isFinite(parsedTimestamp)
    ? new Date(parsedTimestamp).toISOString()
    : at.toISOString();
  if (type === "GROUP_AT_MESSAGE_CREATE") {
    const groupId = stringValue(row.group_openid);
    if (!groupId) return undefined;
    const senderId =
      stringValue(author.member_openid) ??
      stringValue(author.id) ??
      stringValue(author.user_openid);
    if (!senderId) return undefined;
    const senderName =
      stringValue(author.member_nickname) ?? stringValue(author.username);
    return {
      platform: "qq",
      accountId,
      chat: { kind: "group", id: groupId },
      sender: {
        id: senderId,
        ...(senderName ? { name: senderName.slice(0, 100) } : {}),
      },
      messageId,
      text: text.slice(0, MAX_TEXT),
      replyTo: messageId,
      ...(attachments.length ? { media: attachments } : {}),
      receivedAt,
    };
  }
  const userId = stringValue(author.user_openid) ?? stringValue(author.id);
  if (!userId) return undefined;
  return {
    platform: "qq",
    accountId,
    chat: {
      kind: "direct",
      id: userId,
      ...(stringValue(author.username)
        ? { title: stringValue(author.username)!.slice(0, 200) }
        : {}),
    },
    sender: {
      id: userId,
      ...(stringValue(author.username)
        ? { name: stringValue(author.username)!.slice(0, 100) }
        : {}),
    },
    messageId,
    text: text.slice(0, MAX_TEXT),
    replyTo: messageId,
    ...(attachments.length ? { media: attachments } : {}),
    receivedAt,
  };
}

function mediaOf(value: unknown): ImMediaRef[] {
  if (!Array.isArray(value)) return [];
  const media: ImMediaRef[] = [];
  for (const item of value.slice(0, 20)) {
    const row = record(item);
    const id =
      stringValue(row.url) ?? stringValue(row.filename) ?? stringValue(row.id);
    if (!id) continue;
    const mime = stringValue(row.content_type) ?? stringValue(row.mime_type);
    const kind = mime?.startsWith("image/")
      ? "image"
      : mime?.startsWith("audio/")
        ? "audio"
        : mime?.startsWith("video/")
          ? "video"
          : "file";
    const size = numeric(row.size);
    media.push({
      kind,
      id,
      ...(mime ? { mimeType: mime } : {}),
      ...(size !== undefined ? { size } : {}),
    });
  }
  return media;
}

function classifyApiError(
  response: Response,
  body: Record<string, unknown>,
  code: number | undefined
): QqRequestError {
  const message =
    stringValue(body.message) ??
    stringValue(body.msg) ??
    `QQ API returned HTTP ${response.status}`;
  const retryAfterMs = retryAfterFrom(response, body);
  if (response.status === 401 || response.status === 403) {
    return new QqRequestError("unauthorized", "QQ rejected the access token", {
      status: response.status,
    });
  }
  if (response.status === 429) {
    return new QqRequestError("rate_limit", message, {
      status: 429,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (
    code === 304103 ||
    code === 40034005 ||
    code === 40034026 ||
    code === 40034128
  ) {
    return new QqRequestError("window_closed", "QQ reply window is closed", {
      status: response.status,
    });
  }
  if (code === 40034100 || code === 1100100 || code === 22009) {
    return new QqRequestError("rate_limit", message, {
      status: response.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (response.status >= 500 || code === 50055002 || code === 304018) {
    return new QqRequestError("server", message, {
      status: response.status,
    });
  }
  return new QqRequestError("bad_request", message, {
    status: response.status,
  });
}

function classificationFor(
  failure: QqRequestError,
  alreadySent: boolean
): ImSendResult {
  if (failure.kind === "rate_limit") {
    return {
      status: "retry",
      reason: "QQ rate limited the message",
      ...(failure.retryAfterMs !== undefined
        ? { retryAfterMs: failure.retryAfterMs }
        : {}),
    };
  }
  if (failure.kind === "unauthorized") {
    return { status: "discard", reason: "QQ rejected the credentials" };
  }
  if (failure.kind === "window_closed") {
    return { status: "discard", reason: "window_closed" };
  }
  if (failure.kind === "bad_request") {
    return { status: "discard", reason: failure.message };
  }
  if (failure.kind === "server") {
    return alreadySent
      ? { status: "unknown", reason: "QQ response was lost after a chunk" }
      : { status: "retry", reason: "QQ is temporarily unavailable" };
  }
  return { status: "unknown", reason: "QQ response was lost" };
}

function retryAfterFrom(
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

function errorCode(body: Record<string, unknown>): number | undefined {
  return numeric(body.code) ?? numeric(body.err_code) ?? numeric(body.errCode);
}

function parsePayload(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
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

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" || url.protocol === "ws:";
  } catch {
    return false;
  }
}

function defaultSocketFactory(url: string): QqWebSocket {
  const Constructor = (
    globalThis as {
      WebSocket?: new (url: string) => unknown;
    }
  ).WebSocket;
  if (!Constructor) {
    throw new Error("This Node runtime has no WebSocket implementation");
  }
  return new Constructor(url) as QqWebSocket;
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
