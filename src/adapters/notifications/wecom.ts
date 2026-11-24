import type {
  NotificationAdapter,
  NotificationDeliveryAttempt,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import { addressValue, classifyHttp, postJson, truncate } from "./shared.ts";

const ROBOT_MAX = 4_096;
const APP_MAX = 2_000;

/**
 * WeCom (企业微信). A group robot is the default because it needs no organization API; an application
 * message is used when the target names a member (`toUser`) and host credentials are configured. Both
 * speak plain HTTPS, so no Python or SDK is involved.
 */
export function createWecomNotificationAdapter(
  options: {
    webhookUrl?: string;
    corpId?: string;
    corpSecret?: string;
    agentId?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {}
): NotificationAdapter {
  const send = options.fetch ?? fetch;
  let token: { value: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<
    | { ok: true; value: string }
    | { ok: false; attempt: NotificationDeliveryAttempt }
  > {
    if (token && token.expiresAt > Date.now()) {
      return { ok: true, value: token.value };
    }
    if (!options.corpId || !options.corpSecret) {
      return {
        ok: false,
        attempt: { status: "discard", reason: "wecom_app_credentials_missing" },
      };
    }
    const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
    url.searchParams.set("corpid", options.corpId);
    url.searchParams.set("corpsecret", options.corpSecret);
    const result = await getJson(send, url.toString(), options.timeoutMs);
    if (result.kind === "error") {
      return { ok: false, attempt: classifyHttp(result) };
    }
    const body = result.body as Record<string, unknown> | undefined;
    if (result.response.ok && typeof body?.access_token === "string") {
      const expires =
        typeof body.expires_in === "number" ? body.expires_in : 7200;
      token = {
        value: body.access_token,
        expiresAt: Date.now() + Math.max(60, expires - 60) * 1_000,
      };
      return { ok: true, value: body.access_token };
    }
    const errcode =
      typeof body?.errcode === "number" ? body.errcode : undefined;
    const reason = `wecom token error${errcode === undefined ? "" : ` ${errcode}`}${
      typeof body?.errmsg === "string" ? `: ${body.errmsg}` : ""
    }`;
    return {
      ok: false,
      attempt:
        errcode === 40001 || errcode === 40013
          ? { status: "discard", reason }
          : { status: "retry", reason },
    };
  }

  async function sendApp(
    input: NotificationSendInput,
    toUser: string
  ): Promise<NotificationDeliveryAttempt> {
    if (!options.agentId) {
      return { status: "discard", reason: "wecom_agent_id_missing" };
    }
    const current = await accessToken();
    if (!current.ok) return current.attempt;
    const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/message/send");
    url.searchParams.set("access_token", current.value);
    const content = truncate(render(input), APP_MAX);
    const result = await postJson(
      send,
      url.toString(),
      {
        touser: toUser,
        msgtype: "text",
        agentid: Number(options.agentId),
        text: { content },
        safe: 0,
      },
      {
        timeoutMs: options.timeoutMs ?? 10_000,
        headers: { "idempotency-key": input.idempotencyKey },
      }
    );
    if (result.kind === "error") return classifyHttp(result);
    const body = result.body as Record<string, unknown> | undefined;
    const errcode =
      typeof body?.errcode === "number" ? body.errcode : undefined;
    if (errcode === 0) return { status: "sent" };
    if (errcode === 40014 || errcode === 42001) {
      token = undefined;
      return {
        status: "retry",
        reason: `wecom token expired${errcode ? ` (${errcode})` : ""}`,
      };
    }
    const reason = `wecom app error${errcode === undefined ? "" : ` ${errcode}`}${
      typeof body?.errmsg === "string" ? `: ${body.errmsg}` : ""
    }`;
    if (errcode === 45009)
      return { status: "retry", reason, retryAfterMs: 60_000 };
    if (errcode === 81013 || errcode === 40003 || errcode === 60020) {
      return { status: "discard", reason };
    }
    if (!result.response.ok) return { status: "retry", reason };
    return { status: "discard", reason };
  }

  return {
    id: "wecom",
    capabilities: { proactive: true, markdown: true, maxTextLength: ROBOT_MAX },
    accepts(channel: ChannelRef): boolean {
      return wecomMode(channel.address, options) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const mode = wecomMode(input.target.channel.address, options);
      if (!mode) return { status: "discard", reason: "wecom_target_missing" };
      if (mode.kind === "app") return sendApp(input, mode.toUser);
      const content = truncate(
        [
          `**${input.notification.title}**`,
          input.notification.body,
          ...(input.notification.deepLink
            ? [`[Open](${input.notification.deepLink})`]
            : []),
        ].join("\n"),
        ROBOT_MAX
      );
      const result = await postJson(
        send,
        mode.url,
        { msgtype: "markdown", markdown: { content } },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          headers: { "idempotency-key": input.idempotencyKey },
        }
      );
      const attempt = classifyHttp(result);
      if (result.kind !== "response" || !result.body) return attempt;
      const body = result.body as Record<string, unknown>;
      const errcode =
        typeof body.errcode === "number" ? body.errcode : undefined;
      if (errcode === 0) return { status: "sent" };
      const reason = `wecom robot error${errcode === undefined ? "" : ` ${errcode}`}${
        typeof body.errmsg === "string" ? `: ${body.errmsg}` : ""
      }`;
      if (errcode === 45009)
        return { status: "retry", reason, retryAfterMs: 60_000 };
      if (result.response.ok) return { status: "discard", reason };
      return { status: "retry", reason };
    },
  };
}

function wecomMode(
  address: Record<string, string> | undefined,
  options: {
    webhookUrl?: string;
    corpId?: string;
    corpSecret?: string;
    agentId?: string;
  }
):
  | { kind: "app"; toUser: string }
  | { kind: "robot"; url: string }
  | undefined {
  const toUser = addressValue(address, "toUser");
  if (toUser) {
    return options.corpId &&
      options.corpSecret &&
      options.agentId &&
      /^\d+$/.test(options.agentId)
      ? { kind: "app", toUser }
      : undefined;
  }
  const raw =
    addressValue(address, "url") ??
    addressValue(address, "webhookUrl") ??
    options.webhookUrl;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return { kind: "robot", url: url.toString() };
  } catch {
    return undefined;
  }
}

function render(input: NotificationSendInput): string {
  return [
    input.notification.title,
    input.notification.body,
    ...(input.notification.deepLink ? [input.notification.deepLink] : []),
  ].join("\n");
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs = 10_000
): Promise<
  | { kind: "response"; response: Response; body: unknown; text: string }
  | { kind: "error"; error: unknown }
> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { kind: "response", response, body, text };
  } catch (error) {
    return { kind: "error", error };
  }
}
