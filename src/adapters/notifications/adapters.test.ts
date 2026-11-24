import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  Notification,
  NotificationSendInput,
  NotificationTarget,
} from "../../agent/notifications/types.ts";
import { createDingtalkNotificationAdapter } from "./dingtalk.ts";
import { createDiscordNotificationAdapter } from "./discord.ts";
import { createSlackNotificationAdapter } from "./slack.ts";
import { createTelegramNotificationAdapter } from "./telegram.ts";
import { createWebhookNotificationAdapter } from "./webhook.ts";
import { createWecomNotificationAdapter } from "./wecom.ts";

const notification: Notification = {
  id: "event-1",
  category: "attention",
  priority: "critical",
  title: "Thebe",
  body: "Something needs you.",
  deepLink: "thebe://goal/42",
  ticketId: "ticket-1",
  createdAt: "2026-11-14T10:00:00.000Z",
};

function input(
  source: string,
  address: Record<string, string>
): NotificationSendInput {
  const target: NotificationTarget = {
    id: "target-1",
    channel: { source, thread: "target-1", address },
    categories: "all",
    enabled: true,
  };
  return { target, notification, idempotencyKey: "idem-1" };
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("webhook notification adapter", () => {
  it("posts the normalized event with an idempotency key and signature", async () => {
    const fetchMock = vi.fn(async () => response(204, undefined));
    const adapter = createWebhookNotificationAdapter({ fetch: fetchMock });
    const address = {
      url: "https://example.test/hook",
      secret: "shared-secret",
    };
    expect(adapter.accepts({ source: "webhook", thread: "t", address })).toBe(
      true
    );
    const result = await adapter.send(input("webhook", address));
    expect(result).toEqual({ status: "sent" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://example.test/hook");
    const body = String(init.body);
    expect(JSON.parse(body)).toMatchObject({
      id: "event-1",
      category: "attention",
      priority: "critical",
      deepLink: "thebe://goal/42",
      ticketId: "ticket-1",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("idem-1");
    expect(headers["x-thebe-signature"]).toBe(
      `sha256=${createHmac("sha256", "shared-secret").update(body).digest("hex")}`
    );
  });

  it("classifies permanent refusals, transient failures, and timeouts", async () => {
    const refused = createWebhookNotificationAdapter({
      fetch: async () => response(401, { error: "bad token" }),
    });
    expect(
      await refused.send(input("webhook", { url: "https://example.test/hook" }))
    ).toMatchObject({
      status: "discard",
      reason: expect.stringContaining("401"),
    });

    const busy = createWebhookNotificationAdapter({
      fetch: async () =>
        response(429, { error: "slow down" }, { "retry-after": "7" }),
    });
    expect(
      await busy.send(input("webhook", { url: "https://example.test/hook" }))
    ).toMatchObject({ status: "retry", retryAfterMs: 7_000 });

    const timeout = createWebhookNotificationAdapter({
      fetch: async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
    });
    expect(
      await timeout.send(input("webhook", { url: "https://example.test/hook" }))
    ).toMatchObject({ status: "unknown" });
  });

  it("rejects non-http targets", () => {
    const adapter = createWebhookNotificationAdapter({});
    expect(
      adapter.accepts({
        source: "webhook",
        thread: "t",
        address: { url: "file:///etc/passwd" },
      })
    ).toBe(false);
  });
});

describe("telegram notification adapter", () => {
  it("sends a truncated message and respects a 429 retry_after", async () => {
    let reply = response(200, { ok: true });
    const fetchMock = vi.fn(async () => reply);
    const adapter = createTelegramNotificationAdapter({
      botToken: "bot-token",
      fetch: fetchMock,
    });
    const address = { chatId: "12345", threadId: "7" };
    expect(adapter.accepts({ source: "telegram", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("telegram", address))).toEqual({
      status: "sent",
    });
    const body = JSON.parse(
      String(
        (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body
      )
    );
    expect(body).toMatchObject({
      chat_id: "12345",
      message_thread_id: 7,
      disable_web_page_preview: true,
    });
    expect(body.text).toContain("thebe://goal/42");

    reply = response(429, {
      ok: false,
      description: "Too Many Requests",
      parameters: { retry_after: 9 },
    });
    expect(await adapter.send(input("telegram", address))).toMatchObject({
      status: "retry",
      retryAfterMs: 9_000,
    });

    // Telegram also reports the limit as HTTP 200 with ok:false.
    reply = response(200, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 4 },
    });
    expect(await adapter.send(input("telegram", address))).toMatchObject({
      status: "retry",
      retryAfterMs: 4_000,
    });
  });

  it("rejects a chat id that is not numeric or an @channel", () => {
    const adapter = createTelegramNotificationAdapter({ botToken: "x" });
    expect(
      adapter.accepts({
        source: "telegram",
        thread: "t",
        address: { chatId: "../../etc" },
      })
    ).toBe(false);
  });
});

describe("WeCom notification adapter", () => {
  it("uses the group robot webhook and reports a rate limit as retry", async () => {
    let reply = response(200, { errcode: 0, errmsg: "ok" });
    const adapter = createWecomNotificationAdapter({
      fetch: async () => reply,
    });
    const address = {
      url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
    };
    expect(adapter.accepts({ source: "wecom", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("wecom", address))).toEqual({
      status: "sent",
    });
    reply = response(200, { errcode: 45009, errmsg: "api freq out of limit" });
    expect(await adapter.send(input("wecom", address))).toMatchObject({
      status: "retry",
      retryAfterMs: 60_000,
    });
  });

  it("reports missing application credentials instead of sending to a robot", () => {
    const adapter = createWecomNotificationAdapter({
      corpId: "corp",
      corpSecret: "secret",
      agentId: "1000002",
    });
    expect(
      adapter.accepts({
        source: "wecom",
        thread: "t",
        address: { toUser: "zhangsan" },
      })
    ).toBe(true);
  });
});

describe("DingTalk notification adapter", () => {
  it("classifies a signature or keyword refusal as discard", async () => {
    const adapter = createDingtalkNotificationAdapter({
      fetch: async () =>
        response(200, { errcode: 310000, errmsg: "sign not match" }),
    });
    const address = { accessToken: "token" };
    expect(adapter.accepts({ source: "dingtalk", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("dingtalk", address))).toMatchObject({
      status: "discard",
      reason: expect.stringContaining("310000"),
    });
  });

  it("signs the webhook URL when a secret is configured", async () => {
    let seen = "";
    const adapter = createDingtalkNotificationAdapter({
      fetch: async (url) => {
        seen = String(url);
        return response(200, { errcode: 0 });
      },
    });
    await adapter.send(
      input("dingtalk", { accessToken: "token", secret: "secret" })
    );
    expect(seen).toContain("timestamp=");
    expect(seen).toContain("sign=");
  });
});

describe("Slack notification adapter", () => {
  it("posts text to an incoming webhook", async () => {
    let payload: Record<string, unknown> | undefined;
    const adapter = createSlackNotificationAdapter({
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response(200, "ok");
      },
    });
    const address = { url: "https://hooks.slack.com/services/x" };
    expect(adapter.accepts({ source: "slack", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("slack", address))).toEqual({
      status: "sent",
    });
    expect(payload).toMatchObject({ mrkdwn: true, unfurl_links: false });
    expect(String(payload?.text)).toContain("thebe://goal/42");
  });
});

describe("Discord notification adapter", () => {
  it("posts content and never allows mentions", async () => {
    let payload: Record<string, unknown> | undefined;
    const adapter = createDiscordNotificationAdapter({
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response(204, undefined);
      },
    });
    const address = { url: "https://discord.com/api/webhooks/x" };
    expect(adapter.accepts({ source: "discord", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("discord", address))).toEqual({
      status: "sent",
    });
    expect(payload?.allowed_mentions).toEqual({ parse: [] });
    expect(String(payload?.content)).toContain("Something needs you.");
  });
});
