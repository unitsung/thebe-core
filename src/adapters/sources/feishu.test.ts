import { describe, expect, it } from "vitest";
import {
  createFeishuChannelAdapter,
  createFeishuFromEnv,
  createFeishuSource,
} from "./feishu.ts";

type Message = Record<string, unknown>;

function message(overrides: {
  id: string;
  text: string;
  time?: string;
  senderType?: string;
  senderId?: string;
  mentionBot?: boolean;
}): Message {
  return {
    message_id: overrides.id,
    chat_id: "oc_home",
    create_time: overrides.time ?? "1762850000000",
    msg_type: "text",
    sender: {
      id: { open_id: overrides.senderId ?? "ou_unitsung" },
      sender_type: overrides.senderType ?? "user",
    },
    body: { content: JSON.stringify({ text: overrides.text }) },
    mentions: overrides.mentionBot
      ? [{ id: { open_id: "ou_thebe" }, name: "Thebe" }]
      : [],
  };
}

function fakeFeishu(options: { mode?: "p2p" | "group"; messages?: Message[] }) {
  let messages = options.messages ?? [];
  let tokenCalls = 0;
  const sent: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const fetcher = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/auth/v3/tenant_access_token")) {
      tokenCalls += 1;
      return Response.json({
        code: 0,
        tenant_access_token: "token-1",
        expire: 7200,
      });
    }
    if (url.includes("/im/v1/chats/")) {
      return Response.json({
        code: 0,
        data: { chat_mode: options.mode ?? "group" },
      });
    }
    if (url.includes("/im/v1/messages") && (init?.method ?? "GET") === "GET") {
      return Response.json({ code: 0, data: { items: messages } });
    }
    if (url.includes("/im/v1/messages") && init?.method === "POST") {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({
        code: 0,
        data: { message_id: `om_${sent.length}` },
      });
    }
    return Response.json({ code: 404, msg: "not found" });
  }) as typeof fetch;
  return {
    fetcher,
    calls,
    sent,
    tokenCalls: () => tokenCalls,
    setMessages(next: Message[]) {
      messages = next;
    },
  };
}

describe("Feishu Source", () => {
  it("takes a baseline, then reports a mention as an explicit human request", async () => {
    const feishu = fakeFeishu({});
    const source = createFeishuSource({
      appId: "app",
      appSecret: "secret",
      chats: ["oc_home"],
      botOpenId: "ou_thebe",
      fetch: feishu.fetcher,
      now: () => new Date("2026-11-11T10:00:00Z"),
    });

    const baseline = await source.read(undefined);
    expect(baseline.triggers).toEqual([]);

    feishu.setMessages([
      message({
        id: "om_1",
        time: "1762850100000",
        text: "@_user_1 please restart emby",
        mentionBot: true,
      }),
    ]);
    const read = await source.read(baseline.cursor);
    expect(read.triggers).toHaveLength(1);
    expect(read.triggers[0]).toMatchObject({
      source: "feishu",
      kind: "feishu.message",
      threads: ["resource:feishu:chat:oc_home"],
      resource: { kind: "feishu", id: "oc_home" },
      actor: { source: "feishu", id: "ou_unitsung" },
      human: true,
      admission: "explicit",
      addressed: "mention",
      channel: {
        source: "feishu",
        thread: "resource:feishu:chat:oc_home",
        address: { chat: "oc_home" },
      },
    });
    expect(read.triggers[0]?.id).toMatch(/^[a-f0-9]{32}$/);
    expect(feishu.tokenCalls()).toBe(1);

    // The same message in the feed is not reported twice.
    expect((await source.read(read.cursor)).triggers).toEqual([]);
  });

  it("ignores bot messages and group messages that did not address the bot", async () => {
    const feishu = fakeFeishu({});
    const source = createFeishuSource({
      appId: "app",
      appSecret: "secret",
      chats: ["oc_home"],
      botOpenId: "ou_thebe",
      fetch: feishu.fetcher,
      now: () => new Date("2026-11-11T10:00:00Z"),
    });
    const baseline = await source.read(undefined);
    feishu.setMessages([
      message({ id: "om_2", text: "daily chatter" }),
      message({
        id: "om_3",
        text: "automated note",
        senderType: "app",
        mentionBot: true,
      }),
    ]);
    const read = await source.read(baseline.cursor);
    expect(read.triggers.map((trigger) => trigger.admission)).toEqual([
      "ignore",
      "ignore",
    ]);
    expect(read.triggers[0]?.human).toBe(true);
    expect(read.triggers[1]?.human).toBe(false);
  });

  it("treats a direct chat message as an explicit direct request", async () => {
    const feishu = fakeFeishu({ mode: "p2p" });
    const source = createFeishuSource({
      appId: "app",
      appSecret: "secret",
      chats: ["oc_direct"],
      fetch: feishu.fetcher,
      now: () => new Date("2026-11-11T10:00:00Z"),
    });
    const baseline = await source.read(undefined);
    feishu.setMessages([message({ id: "om_4", text: "what is running?" })]);
    const read = await source.read(baseline.cursor);
    expect(read.triggers[0]).toMatchObject({
      admission: "explicit",
      addressed: "direct",
      human: true,
    });
  });

  it("marks unaddressed group messages inferred only when asked", async () => {
    const feishu = fakeFeishu({});
    const source = createFeishuSource({
      appId: "app",
      appSecret: "secret",
      chats: ["oc_home"],
      admitUnaddressed: true,
      fetch: feishu.fetcher,
      now: () => new Date("2026-11-11T10:00:00Z"),
    });
    const baseline = await source.read(undefined);
    feishu.setMessages([
      message({ id: "om_5", text: "the nas fans are loud" }),
    ]);
    const read = await source.read(baseline.cursor);
    expect(read.triggers[0]?.admission).toBe("inferred");
  });
});

describe("Feishu Channel", () => {
  it("sends a text notice with the idempotency key as the message uuid", async () => {
    const feishu = fakeFeishu({});
    const adapter = createFeishuChannelAdapter({
      appId: "app",
      appSecret: "secret",
      chats: ["oc_home"],
      fetch: feishu.fetcher,
    });
    const channel = {
      source: "feishu",
      thread: "resource:feishu:chat:oc_home",
      address: { chat: "oc_home" },
    };
    expect(adapter.accepts(channel)).toBe(true);
    expect(adapter.accepts({ ...channel, address: { chat: "oc_other" } })).toBe(
      false
    );

    await adapter.send({
      channel,
      notice: {
        id: "n1",
        ticketId: "t1",
        goalId: "g1",
        type: "goal_needs_person",
        reason: "answer",
        message: "I need your answer about the backup.",
      },
      idempotencyKey: "b".repeat(32),
    });
    expect(feishu.sent).toHaveLength(1);
    expect(feishu.sent[0]).toMatchObject({
      receive_id: "oc_home",
      msg_type: "text",
      uuid: "b".repeat(32),
    });
    expect(JSON.parse(String(feishu.sent[0]?.content))).toEqual({
      text: "I need your answer about the backup.",
    });
  });
});

describe("Feishu environment wiring", () => {
  it("needs app credentials and at least one chat", () => {
    expect(createFeishuFromEnv({})).toBeUndefined();
    expect(
      createFeishuFromEnv({
        THEBE_FEISHU_APP_ID: "a",
        THEBE_FEISHU_APP_SECRET: "b",
      })
    ).toBeUndefined();
    expect(
      createFeishuFromEnv({
        THEBE_FEISHU_APP_ID: "a",
        THEBE_FEISHU_APP_SECRET: "b",
        THEBE_FEISHU_CHATS: "oc_home",
      })?.source.id
    ).toBe("feishu");
  });
});
