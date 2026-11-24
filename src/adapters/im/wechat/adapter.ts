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
} from "../../../agent/im/types.ts";
import {
  WECHAT_DEFAULT_BASE_URL,
  WECHAT_MAX_TEXT,
  WechatApiError,
  getWechatUpdates,
  isWechatSessionExpired,
  resolveWechatBaseUrl,
  sendWechatMessage,
  truncateWechatText,
  type WechatMessage,
} from "./protocol.ts";
import { createWechatLoginAdapter } from "./login.ts";

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

function tokenOf(credentials: ImAdapterCredentials): string {
  return credentials.token?.trim() ?? "";
}

export function validateWechatCredentials(
  credentials: ImAdapterCredentials
): string | undefined {
  if (!tokenOf(credentials)) return "missing credential: token";
  return undefined;
}

export function wechatCursorIdentity(
  credentials: ImAdapterCredentials
): string | undefined {
  const token = tokenOf(credentials);
  return token
    ? createHash("sha256").update(token).digest("hex").slice(0, 16)
    : undefined;
}

/**
 * Weixin ClawBot through Tencent's iLink HTTP protocol. It is reply-only by design: every outbound
 * message carries the `context_token` of the inbound turn it answers. The gateway never selects it
 * for proactive notices.
 */
export function createWechatImAdapter(input: {
  account: ImAccount;
  credentials: ImAdapterCredentials;
  cursor?: string;
  onCursor(cursor: string): void;
  onError?(message: string): void;
  fetch?: typeof fetch;
  now?: () => Date;
}): ImAdapter {
  const now = input.now ?? (() => new Date());
  const token = tokenOf(input.credentials);
  const baseUrl = resolveWechatBaseUrl(input.credentials);
  const capabilities: ImCapabilities = {
    proactive: false,
    replyOnly: true,
    recall: false,
    media: false,
    maxTextLength: WECHAT_MAX_TEXT,
    markdown: false,
    threads: false,
    typing: false,
  };
  let health: ImHealth = { state: "stopped" };
  let cursor = input.cursor;
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let inbound: ((message: ImInbound) => Promise<void>) | undefined;

  function setHealth(next: ImHealth): void {
    health = next;
    if (next.state === "error" && next.detail) input.onError?.(next.detail);
  }

  function parseMessage(
    message: WechatMessage,
    accountId: string
  ): ImInbound | undefined {
    if (message.message_type !== 1) return undefined;
    if (message.group_id) return undefined;
    const from = message.from_user_id?.trim();
    if (!from) return undefined;
    const text = message.item_list
      ?.find((item) => item.type === 1)
      ?.text_item?.text?.trim();
    if (!text) return undefined;
    const messageId = message.message_id;
    if (messageId === undefined || messageId === null) return undefined;
    const receivedAt =
      typeof message.create_time_ms === "number"
        ? new Date(message.create_time_ms).toISOString()
        : now().toISOString();
    return {
      platform: "wechat",
      accountId,
      chat: { kind: "direct", id: from },
      sender: { id: from },
      messageId: String(messageId),
      text,
      replyTo: String(messageId),
      ...(message.context_token ? { contextToken: message.context_token } : {}),
      receivedAt,
    };
  }

  async function pollLoop(active: AbortController): Promise<void> {
    let backoff = 0;
    while (!active.signal.aborted) {
      try {
        const updates = await getWechatUpdates({
          baseUrl,
          token,
          ...(cursor ? { cursor } : {}),
          ...(input.fetch ? { fetchImpl: input.fetch } : {}),
          signal: active.signal,
        });
        setHealth({ state: "connected", since: now().toISOString() });
        backoff = 0;
        if (updates.cursor && updates.cursor !== cursor) {
          cursor = updates.cursor;
          input.onCursor(cursor);
        }
        for (const raw of updates.messages) {
          if (active.signal.aborted) return;
          const message = parseMessage(raw, input.account.id);
          if (!message || !inbound) continue;
          try {
            await inbound(message);
          } catch {
            // The gateway records its own failure; a poison message must not stop polling.
          }
        }
      } catch (error) {
        if (active.signal.aborted) return;
        if (isWechatSessionExpired(error)) {
          setHealth({
            state: "needs_login",
            detail: "Weixin session expired; scan a new QR code",
            code: "session_expired",
            since: now().toISOString(),
          });
          return;
        }
        const detail =
          error instanceof WechatApiError
            ? error.message
            : "Weixin polling failed";
        setHealth({ state: "error", detail, since: now().toISOString() });
        const wait = BACKOFF_MS[Math.min(backoff, BACKOFF_MS.length - 1)]!;
        backoff += 1;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  return {
    platform: "wechat",
    capabilities,
    async start() {
      if (!token) {
        setHealth({
          state: "needs_login",
          detail: "Weixin bot token is missing",
          code: "token_missing",
        });
        return;
      }
      controller = new AbortController();
      setHealth({ state: "starting", since: now().toISOString() });
      loop = pollLoop(controller);
    },
    async stop() {
      controller?.abort();
      controller = undefined;
      await loop?.catch(() => undefined);
      loop = undefined;
      setHealth({ state: "stopped" });
    },
    async health() {
      return health;
    },
    async send(sendInput: ImSendInput): Promise<ImSendResult> {
      if (!token) return { status: "discard", reason: "token_missing" };
      if (sendInput.mode === "proactive") {
        return { status: "discard", reason: "proactive_not_supported" };
      }
      if (!sendInput.contextToken) {
        return { status: "discard", reason: "context_token_required" };
      }
      try {
        const result = await sendWechatMessage({
          baseUrl,
          token,
          toUserId: sendInput.chat.id,
          text: truncateWechatText(sendInput.text),
          contextToken: sendInput.contextToken,
          clientId: sendInput.idempotencyKey.slice(0, 64),
          ...(input.fetch ? { fetchImpl: input.fetch } : {}),
        });
        setHealth({ state: "connected", since: now().toISOString() });
        return {
          status: "sent",
          ...(result.messageId ? { platformMessageId: result.messageId } : {}),
        };
      } catch (error) {
        if (isWechatSessionExpired(error)) {
          setHealth({
            state: "needs_login",
            detail: "Weixin session expired; scan a new QR code",
            code: "session_expired",
          });
          return { status: "discard", reason: "session_expired" };
        }
        if (error instanceof WechatApiError) {
          if (
            error.status === 429 ||
            (error.status ?? 0) >= 500 ||
            error.status === undefined
          ) {
            return { status: "retry", reason: error.message };
          }
          return { status: "discard", reason: error.message };
        }
        return {
          status: "retry",
          reason: error instanceof Error ? error.message : "Weixin send failed",
        };
      }
    },
    onInbound(handler) {
      inbound = handler;
    },
    canSendProactively() {
      return false;
    },
  };
}

/** The host factory: QR login plus the token/baseurl credentials it returns. */
export function createWechatFactory(
  env: NodeJS.ProcessEnv = process.env
): ImAdapterFactory {
  const apiBase = env.THEBE_WECHAT_API_BASE?.trim() || WECHAT_DEFAULT_BASE_URL;
  return {
    platform: "wechat",
    credentials: [],
    validateCredentials: validateWechatCredentials,
    cursorIdentity: wechatCursorIdentity,
    create: (createInput) =>
      createWechatImAdapter({
        account: createInput.account,
        credentials: {
          ...createInput.credentials,
          ...(createInput.credentials.baseurl?.trim()
            ? {}
            : { baseurl: apiBase }),
        },
        ...(createInput.cursor ? { cursor: createInput.cursor } : {}),
        onCursor: createInput.onCursor,
        ...(createInput.onError ? { onError: createInput.onError } : {}),
        ...(createInput.fetch ? { fetch: createInput.fetch } : {}),
        ...(createInput.now ? { now: createInput.now } : {}),
      }),
    createLogin: (loginInput) =>
      createWechatLoginAdapter({
        baseUrl: apiBase,
        ...(loginInput.fetch ? { fetchImpl: loginInput.fetch } : {}),
        ...(loginInput.now ? { now: loginInput.now } : {}),
      }),
  };
}
