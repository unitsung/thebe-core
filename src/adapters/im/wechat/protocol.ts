/**
 * A small iLink / Weixin ClawBot client.
 *
 * The wire protocol and the message shapes are derived from Tencent's MIT-licensed
 * Weixin ClawBot protocol layer (Copyright (C) 2026 Tencent). No external agent
 * runtime, account store or logger is copied: Core owns credentials, persistence
 * and health. See LICENSE-Tencent-weixin.txt.
 */

export const WECHAT_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const WECHAT_APP_ID = "bot";
export const WECHAT_CLIENT_VERSION = "65536"; // 1.0.0 as 0x00MMNNPP
export const WECHAT_CHANNEL_VERSION = "1.0.0";
export const WECHAT_MAX_TEXT = 2_048;
const REQUEST_TIMEOUT_MS = 20_000;
const LONG_POLL_TIMEOUT_MS = 35_000;
const QR_POLL_TIMEOUT_MS = 35_000;

export type WechatFetch = typeof fetch;

export type WechatCredentials = {
  token?: string;
  baseurl?: string;
  accountId?: string;
  userId?: string;
};

export type WechatMessage = {
  seq?: number;
  message_id?: string | number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: WechatMessageItem[];
};

export type WechatMessageItem = {
  type?: number;
  text_item?: { text?: string };
};

export type WechatUpdates = {
  messages: WechatMessage[];
  cursor?: string;
  longPollTimeoutMs?: number;
};

export type WechatQRCode = {
  qrcode: string;
  qrcodeImgContent: string;
};

export type WechatQRStatus = {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "confirmed_but_need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  botToken?: string;
  ilinkBotId?: string;
  baseurl?: string;
  ilinkUserId?: string;
  redirectHost?: string;
};

export class WechatApiError extends Error {
  readonly status?: number;
  readonly code?: number;

  constructor(
    message: string,
    options: { status?: number; code?: number } = {}
  ) {
    super(message);
    this.name = "WechatApiError";
    this.status = options.status;
    this.code = options.code;
  }
}

type RequestInput = {
  baseUrl: string;
  endpoint: string;
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: WechatFetch;
  signal?: AbortSignal;
};

function baseInfo(): Record<string, unknown> {
  return {
    channel_version: WECHAT_CHANNEL_VERSION,
    bot_agent: "Thebe",
  };
}

function trimBaseUrl(value: string | undefined): string {
  return (value?.trim() || WECHAT_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** The bot token decides the account; a base URL can move on an IDC redirect. */
export function resolveWechatBaseUrl(credentials: WechatCredentials): string {
  return trimBaseUrl(credentials.baseurl);
}

function randomWechatUin(): string {
  const value = Math.floor(Math.random() * 0x1_0000_0000);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": WECHAT_APP_ID,
    "iLink-App-ClientVersion": WECHAT_CLIENT_VERSION,
  };
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const row = payload as Record<string, unknown>;
    if (typeof row.errmsg === "string" && row.errmsg.trim())
      return row.errmsg.trim();
    if (typeof row.error === "string" && row.error.trim())
      return row.error.trim();
  }
  return fallback;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

async function request(input: RequestInput): Promise<Record<string, unknown>> {
  const url = `${trimBaseUrl(input.baseUrl)}/${input.endpoint.replace(/^\/+/, "")}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? REQUEST_TIMEOUT_MS
  );
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: input.method ?? "POST",
      headers:
        (input.method ?? "POST") === "GET"
          ? commonHeaders()
          : authHeaders(input.token),
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal,
    });
  } catch (error) {
    throw new WechatApiError(
      error instanceof Error && error.name === "AbortError"
        ? "wechat request timed out"
        : "wechat request failed"
    );
  } finally {
    clearTimeout(timeout);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WechatApiError(`wechat returned HTTP ${response.status}`, {
      status: response.status,
    });
  }
  if (!response.ok) {
    throw new WechatApiError(
      errorMessage(payload, `wechat returned HTTP ${response.status}`),
      {
        status: response.status,
        code: numeric((payload as Record<string, unknown>)?.errcode),
      }
    );
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const row = payload as Record<string, unknown>;
    if (typeof row.ret === "number" && row.ret !== 0) {
      throw new WechatApiError(
        errorMessage(row, `wechat returned ret ${row.ret}`),
        {
          code: typeof row.errcode === "number" ? row.errcode : row.ret,
        }
      );
    }
    if (typeof row.errcode === "number" && row.errcode !== 0) {
      throw new WechatApiError(
        errorMessage(row, `wechat returned errcode ${row.errcode}`),
        {
          code: row.errcode,
        }
      );
    }
    return row;
  }
  return {};
}

export async function getWechatUpdates(input: {
  baseUrl: string;
  token: string;
  cursor?: string;
  fetchImpl?: WechatFetch;
  signal?: AbortSignal;
}): Promise<WechatUpdates> {
  const row = await request({
    baseUrl: input.baseUrl,
    endpoint: "ilink/bot/getupdates",
    token: input.token,
    body: {
      get_updates_buf: input.cursor ?? "",
      base_info: baseInfo(),
    },
    timeoutMs: LONG_POLL_TIMEOUT_MS + 5_000,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
  const messages = Array.isArray(row.msgs) ? (row.msgs as WechatMessage[]) : [];
  return {
    messages,
    ...(typeof row.get_updates_buf === "string" && row.get_updates_buf
      ? { cursor: row.get_updates_buf }
      : {}),
    ...(numeric(row.longpolling_timeout_ms) !== undefined
      ? { longPollTimeoutMs: numeric(row.longpolling_timeout_ms) }
      : {}),
  };
}

export async function sendWechatMessage(input: {
  baseUrl: string;
  token: string;
  toUserId: string;
  text: string;
  contextToken: string;
  clientId: string;
  fetchImpl?: WechatFetch;
  signal?: AbortSignal;
}): Promise<{ messageId?: string }> {
  const row = await request({
    baseUrl: input.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    token: input.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: input.toUserId,
        client_id: input.clientId,
        message_type: 2,
        message_state: 2,
        context_token: input.contextToken,
        item_list: [{ type: 1, text_item: { text: input.text } }],
      },
      base_info: baseInfo(),
    },
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });
  const messageId = row.message_id;
  return messageId === undefined || messageId === null
    ? {}
    : { messageId: String(messageId) };
}

export async function getWechatQRCode(input: {
  baseUrl: string;
  fetchImpl?: WechatFetch;
}): Promise<WechatQRCode> {
  const row = await request({
    baseUrl: input.baseUrl,
    endpoint: "ilink/bot/get_bot_qrcode?bot_type=3",
    body: { local_token_list: [] },
    fetchImpl: input.fetchImpl,
  });
  if (typeof row.qrcode !== "string" || !row.qrcode) {
    throw new WechatApiError("wechat returned no QR key");
  }
  const content =
    typeof row.qrcode_img_content === "string" && row.qrcode_img_content
      ? row.qrcode_img_content
      : row.qrcode;
  return { qrcode: row.qrcode, qrcodeImgContent: content };
}

export async function pollWechatQRCode(input: {
  baseUrl: string;
  qrcode: string;
  verifyCode?: string;
  fetchImpl?: WechatFetch;
}): Promise<WechatQRStatus> {
  const query = new URLSearchParams({ qrcode: input.qrcode });
  if (input.verifyCode?.trim())
    query.set("verify_code", input.verifyCode.trim());
  const row = await request({
    baseUrl: input.baseUrl,
    endpoint: `ilink/bot/get_qrcode_status?${query.toString()}`,
    method: "GET",
    timeoutMs: QR_POLL_TIMEOUT_MS,
    fetchImpl: input.fetchImpl,
  });
  const status = row.status;
  if (typeof status !== "string") {
    throw new WechatApiError("wechat returned no QR status");
  }
  return {
    status: status as WechatQRStatus["status"],
    ...(typeof row.bot_token === "string" ? { botToken: row.bot_token } : {}),
    ...(typeof row.ilink_bot_id === "string"
      ? { ilinkBotId: row.ilink_bot_id }
      : {}),
    ...(typeof row.baseurl === "string" ? { baseurl: row.baseurl } : {}),
    ...(typeof row.ilink_user_id === "string"
      ? { ilinkUserId: row.ilink_user_id }
      : {}),
    ...(typeof row.redirect_host === "string"
      ? { redirectHost: row.redirect_host }
      : {}),
  };
}

export function isWechatSessionExpired(error: unknown): boolean {
  return error instanceof WechatApiError && error.code === -14;
}

export function truncateWechatText(
  text: string,
  limit = WECHAT_MAX_TEXT
): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}
