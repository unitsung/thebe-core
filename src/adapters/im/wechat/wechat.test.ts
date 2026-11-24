import { describe, expect, it, vi } from "vitest";
import type { ImAccount, ImInbound } from "../../../agent/im/types.ts";
import { createWechatImAdapter, createWechatFactory } from "./adapter.ts";
import { createWechatLoginAdapter } from "./login.ts";

const account: ImAccount = {
  id: "im-wechat-1",
  platform: "wechat",
  label: "Weixin",
  enabled: true,
  createdAt: "2026-11-16T00:00:00.000Z",
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function abortableNever(
  signal: AbortSignal | null | undefined
): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

describe("Weixin adapter", () => {
  it("long-polls a text message, forwards context and replies in the same thread", async () => {
    let getUpdatesCalls = 0;
    let inboundSeen: ImInbound | undefined;
    const replyBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/ilink/bot/getupdates")) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          expect(init?.headers).toMatchObject({
            AuthorizationType: "ilink_bot_token",
            Authorization: "Bearer token-1",
            "iLink-App-Id": "bot",
          });
          const headers = init?.headers as Record<string, string>;
          expect(headers["X-WECHAT-UIN"]).toBeTruthy();
          return json({
            ret: 0,
            get_updates_buf: "cursor-2",
            msgs: [
              {
                message_id: "m1",
                from_user_id: "wx-user",
                message_type: 1,
                message_state: 2,
                context_token: "ctx-1",
                create_time_ms: 1_760_000_000_000,
                item_list: [{ type: 1, text_item: { text: "hello" } }],
              },
            ],
          });
        }
        return abortableNever(init?.signal);
      }
      if (url.endsWith("/ilink/bot/sendmessage")) {
        replyBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        return json({ ret: 0, message_id: "m2" });
      }
      return json({ ret: 0 });
    };

    const adapter = createWechatImAdapter({
      account,
      credentials: { token: "token-1", baseurl: "https://weixin.test" },
      fetch: fetchImpl,
      onCursor: (cursor) => {
        expect(cursor).toBe("cursor-2");
      },
    });
    adapter.onInbound(async (message) => {
      inboundSeen = message;
    });

    await adapter.start();
    for (let i = 0; i < 50 && !inboundSeen; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(inboundSeen?.chat).toEqual({ kind: "direct", id: "wx-user" });
    expect(inboundSeen?.contextToken).toBe("ctx-1");
    expect(inboundSeen?.text).toBe("hello");

    const sent = await adapter.send({
      platform: "wechat",
      accountId: account.id,
      chat: { kind: "direct", id: "wx-user" },
      text: "hi",
      mode: "reply",
      contextToken: "ctx-1",
      idempotencyKey: "reply-1",
    });
    expect(sent.status).toBe("sent");
    expect(replyBodies[0]?.msg).toMatchObject({
      to_user_id: "wx-user",
      context_token: "ctx-1",
      client_id: "reply-1",
    });
    await adapter.stop();
    expect((await adapter.health()).state).toBe("stopped");
  });

  it("does not pretend to send a proactive notice or a reply without a context token", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createWechatImAdapter({
      account,
      credentials: { token: "token-1" },
      fetch: fetchImpl,
      onCursor: () => {},
    });
    expect(adapter.capabilities.proactive).toBe(false);
    const proactive = await adapter.send({
      platform: "wechat",
      accountId: account.id,
      chat: { kind: "direct", id: "wx-user" },
      text: "proactive",
      mode: "proactive",
      idempotencyKey: "p1",
    });
    expect(proactive).toEqual({
      status: "discard",
      reason: "proactive_not_supported",
    });

    const noContext = await adapter.send({
      platform: "wechat",
      accountId: account.id,
      chat: { kind: "direct", id: "wx-user" },
      text: "reply",
      mode: "reply",
      idempotencyKey: "p2",
    });
    expect(noContext).toEqual({
      status: "discard",
      reason: "context_token_required",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a session-expired poll as needs_login", async () => {
    const fetchImpl: typeof fetch = async () =>
      json({ ret: -14, errcode: -14 });
    const adapter = createWechatImAdapter({
      account,
      credentials: { token: "token-1" },
      fetch: fetchImpl,
      onCursor: () => {},
    });
    await adapter.start();
    for (
      let i = 0;
      i < 50 && (await adapter.health()).state !== "needs_login";
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await adapter.health()).state).toBe("needs_login");
    await adapter.stop();
  });

  it("registers the Weixin platform as QR-login only", async () => {
    const factory = createWechatFactory({});
    expect(factory.platform).toBe("wechat");
    expect(factory.credentials).toEqual([]);
    expect(factory.createLogin).toBeTypeOf("function");
    expect(factory.create).toBeTypeOf("function");
  });

  it("does not expose a token or credentials in the QR challenge", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/get_bot_qrcode")) {
        return json({
          qrcode: "qr-key",
          qrcode_img_content: "https://weixin.test/qr",
        });
      }
      if (url.includes("/get_qrcode_status")) {
        return json({
          status: "confirmed",
          bot_token: "secret-token",
          baseurl: "https://weixin.test",
          ilink_bot_id: "bot-1",
          ilink_user_id: "user-1",
        });
      }
      return json({ ret: 0 });
    };
    const login = createWechatLoginAdapter({
      fetchImpl,
      baseUrl: "https://weixin.test",
    });
    const challenge = await login.begin({ label: "Phone" });
    expect(challenge.kind).toBe("qr");
    expect(challenge.content).toBe("https://weixin.test/qr");
    expect(JSON.stringify(challenge)).not.toContain("secret-token");
    const poll = await login.poll(challenge.id);
    expect(poll.state).toBe("confirmed");
    expect(poll.credentials).toMatchObject({
      token: "secret-token",
      baseurl: "https://weixin.test",
      accountId: "bot-1",
      userId: "user-1",
    });
    expect(JSON.stringify(poll)).toContain("secret-token"); // only Core sees credentials
  });
});
