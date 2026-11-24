import { createHmac } from "node:crypto";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  Notification,
  NotificationSendInput,
  NotificationTarget,
} from "../../agent/notifications/types.ts";
import { createIrcNotificationAdapter } from "./irc.ts";
import { createLineNotificationAdapter } from "./line.ts";
import { createMattermostNotificationAdapter } from "./mattermost.ts";
import { createNextcloudTalkNotificationAdapter } from "./nextcloud-talk.ts";
import { createSynologyChatNotificationAdapter } from "./synology-chat.ts";
import { createTwitchNotificationAdapter } from "./twitch.ts";
import { createZaloNotificationAdapter } from "./zalo.ts";

const notification: Notification = {
  id: "event-1",
  category: "attention",
  priority: "critical",
  title: "Thebe",
  body: "Something needs you.",
  deepLink: "thebe://goal/42",
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
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type Captured = { url: string; init: RequestInit };

function capture(reply: Response): {
  fetcher: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply;
  }) as typeof fetch;
  return { fetcher, calls };
}

function jsonBody(call: Captured): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function headers(call: Captured): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe("Mattermost notification adapter", () => {
  it("posts to an incoming webhook with mentions disabled", async () => {
    const { fetcher, calls } = capture(response(200, "ok"));
    const adapter = createMattermostNotificationAdapter({ fetch: fetcher });
    const address = {
      url: "https://mm.example/hooks/abc",
      channel: "town-square",
    };
    expect(
      adapter.accepts({ source: "mattermost", thread: "t", address })
    ).toBe(true);
    expect(await adapter.send(input("mattermost", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe("https://mm.example/hooks/abc");
    expect(jsonBody(calls[0]!)).toMatchObject({
      text: "Thebe\n\nSomething needs you.\n\nthebe://goal/42",
      channel: "town-square",
      props: { disable_mentions: true },
    });
  });

  it("rejects a non-http webhook", () => {
    const adapter = createMattermostNotificationAdapter();
    expect(
      adapter.accepts({
        source: "mattermost",
        thread: "t",
        address: { url: "file:///etc/passwd" },
      })
    ).toBe(false);
  });
});

describe("Synology Chat notification adapter", () => {
  it("posts the payload form field and accepts a successful response", async () => {
    const { fetcher, calls } = capture(response(200, { success: true }));
    const adapter = createSynologyChatNotificationAdapter({ fetch: fetcher });
    const address = { url: "https://chat.example/webapi/entry.cgi?token=x" };
    expect(await adapter.send(input("synology-chat", address))).toEqual({
      status: "sent",
    });
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(JSON.parse(form.get("payload") ?? "{}")).toEqual({
      text: "Thebe\n\nSomething needs you.\n\nthebe://goal/42",
    });
    expect(headers(calls[0]!)).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
  });

  it("treats a JSON success false as a refusal", async () => {
    const { fetcher } = capture(response(200, { success: false }));
    const adapter = createSynologyChatNotificationAdapter({ fetch: fetcher });
    expect(
      await adapter.send(
        input("synology-chat", { url: "https://chat.example/hook" })
      )
    ).toMatchObject({ status: "discard" });
  });
});

describe("LINE notification adapter", () => {
  it("pushes text with a deterministic retry key", async () => {
    const { fetcher, calls } = capture(response(200, {}));
    const adapter = createLineNotificationAdapter({
      channelAccessToken: "line-token",
      fetch: fetcher,
    });
    const address = { to: "U1234567890abcdef" };
    expect(adapter.accepts({ source: "line", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("line", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe("https://api.line.me/v2/bot/message/push");
    expect(headers(calls[0]!)).toMatchObject({
      authorization: "Bearer line-token",
      "x-line-retry-key": expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/
      ),
    });
    expect(jsonBody(calls[0]!)).toEqual({
      to: "U1234567890abcdef",
      messages: [
        {
          type: "text",
          text: "Thebe\n\nSomething needs you.\n\nthebe://goal/42",
        },
      ],
    });
  });

  it("honors Retry-After on a 429", async () => {
    const { fetcher } = capture(response(429, {}, { "retry-after": "30" }));
    const adapter = createLineNotificationAdapter({
      channelAccessToken: "line-token",
      fetch: fetcher,
    });
    expect(
      await adapter.send(input("line", { to: "U1234567890abcdef" }))
    ).toMatchObject({ status: "retry", retryAfterMs: 30_000 });
  });
});

describe("Zalo notification adapter", () => {
  it("uses the official bot endpoint and reports ok false as a refusal", async () => {
    const { fetcher, calls } = capture(response(200, { ok: true }));
    const adapter = createZaloNotificationAdapter({
      token: "bot-token",
      fetch: fetcher,
    });
    const address = { chatId: "chat-1" };
    expect(await adapter.send(input("zalo", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe(
      "https://bot-api.zaloplatforms.com/botbot-token/sendMessage"
    );
    expect(jsonBody(calls[0]!)).toEqual({
      chat_id: "chat-1",
      text: "Thebe\n\nSomething needs you.\n\nthebe://goal/42",
    });
  });

  it("maps a 429 body and a permanent body differently", async () => {
    const busy = createZaloNotificationAdapter({
      token: "bot-token",
      fetch: async () =>
        response(200, {
          ok: false,
          error_code: 429,
          description: "slow down",
        }),
    });
    expect(await busy.send(input("zalo", { chatId: "chat-1" }))).toMatchObject({
      status: "retry",
      retryAfterMs: 60_000,
    });

    const refused = createZaloNotificationAdapter({
      token: "bot-token",
      fetch: async () =>
        response(200, {
          ok: false,
          error_code: 400,
          description: "bad chat",
        }),
    });
    expect(
      await refused.send(input("zalo", { chatId: "chat-1" }))
    ).toMatchObject({ status: "discard" });
  });
});

describe("Nextcloud Talk notification adapter", () => {
  it("signs the exact message and sends it to the room", async () => {
    const { fetcher, calls } = capture(
      response(200, {
        ocs: { meta: { statuscode: 200 }, data: { id: 7 } },
      })
    );
    const adapter = createNextcloudTalkNotificationAdapter({
      url: "https://cloud.example",
      botSecret: "bot-secret",
      fetch: fetcher,
    });
    const address = { roomToken: "room-1" };
    expect(await adapter.send(input("nextcloud-talk", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe(
      "https://cloud.example/ocs/v2.php/apps/spreed/api/v1/bot/room-1/message"
    );
    const message = String(jsonBody(calls[0]!).message);
    expect(message).toBe("Thebe\n\nSomething needs you.\n\nthebe://goal/42");
    const sentHeaders = headers(calls[0]!);
    const random = sentHeaders["X-Nextcloud-Talk-Bot-Random"];
    expect(random).toMatch(/^[0-9a-f]{64}$/);
    const signature = createHmac("sha256", "bot-secret")
      .update(String(random) + message)
      .digest("hex");
    expect(sentHeaders).toMatchObject({
      "OCS-APIRequest": "true",
      "X-Nextcloud-Talk-Bot-Signature": signature,
    });
  });

  it("maps an OCS error envelope instead of trusting HTTP 200", async () => {
    const { fetcher } = capture(
      response(200, { ocs: { meta: { statuscode: 429, message: "busy" } } })
    );
    const adapter = createNextcloudTalkNotificationAdapter({
      url: "https://cloud.example",
      botSecret: "bot-secret",
      fetch: fetcher,
    });
    expect(
      await adapter.send(input("nextcloud-talk", { roomToken: "room-1" }))
    ).toMatchObject({ status: "retry", retryAfterMs: 60_000 });
  });
});

describe("Twitch notification adapter", () => {
  it("posts to Helix with the user token and client id", async () => {
    const { fetcher, calls } = capture(
      response(200, { data: [{ message_id: "m1", is_sent: true }] })
    );
    const adapter = createTwitchNotificationAdapter({
      clientId: "client-id",
      userAccessToken: "user-token",
      senderId: "141981764",
      fetch: fetcher,
    });
    const address = { broadcasterId: "12826" };
    expect(await adapter.send(input("twitch", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe("https://api.twitch.tv/helix/chat/messages");
    expect(headers(calls[0]!)).toMatchObject({
      authorization: "Bearer user-token",
      "client-id": "client-id",
    });
    expect(jsonBody(calls[0]!)).toEqual({
      broadcaster_id: "12826",
      sender_id: "141981764",
      message: "Thebe Something needs you. thebe://goal/42",
    });
  });

  it("treats an empty or unsent receipt as a discard", async () => {
    const adapter = createTwitchNotificationAdapter({
      clientId: "client-id",
      userAccessToken: "user-token",
      senderId: "141981764",
      fetch: async () => response(200, { data: [] }),
    });
    expect(
      await adapter.send(input("twitch", { broadcasterId: "12826" }))
    ).toMatchObject({ status: "discard" });
  });
});

describe("IRC notification adapter", () => {
  function socket(): {
    stream: Duplex;
    written: string[];
    receive: (line: string) => void;
  } {
    const written: string[] = [];
    const stream = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        written.push(String(chunk));
        callback();
      },
    });
    return {
      stream,
      written,
      receive: (line) => {
        stream.push(`${line}\r\n`);
      },
    };
  }

  it("registers, joins, sends one sanitized line and quits", async () => {
    const fake = socket();
    const adapter = createIrcNotificationAdapter({
      host: "irc.example",
      port: 6697,
      tls: true,
      nick: "thebe",
      connect: () => fake.stream,
    });
    expect(
      adapter.accepts({
        source: "irc",
        thread: "t",
        address: { channel: "#ops" },
      })
    ).toBe(true);
    const pending = adapter.send(input("irc", { channel: "#ops" }));
    await new Promise((resolve) => setImmediate(resolve));
    fake.receive(":server 001 thebe :welcome");
    await new Promise((resolve) => setImmediate(resolve));
    fake.receive(":server 366 thebe #ops :End of /NAMES list.");
    expect(await pending).toEqual({ status: "sent" });
    expect(fake.written.join("")).toContain("NICK thebe\r\n");
    expect(fake.written.join("")).toContain("JOIN #ops\r\n");
    expect(fake.written.join("")).toContain(
      "PRIVMSG #ops :Thebe Something needs you. thebe://goal/42\r\n"
    );
    expect(fake.written.join("")).toContain(
      "QUIT :Thebe notification sent\r\n"
    );
  });

  it("times out as retryable before the message is sent", async () => {
    const fake = socket();
    const adapter = createIrcNotificationAdapter({
      host: "irc.example",
      port: 6697,
      tls: true,
      nick: "thebe",
      timeoutMs: 30,
      connect: () => fake.stream,
    });
    expect(await adapter.send(input("irc", { channel: "#ops" }))).toMatchObject(
      { status: "retry" }
    );
  });

  it("rejects a channel name that could inject a command", () => {
    const adapter = createIrcNotificationAdapter({
      host: "irc.example",
      port: 6697,
      tls: true,
      nick: "thebe",
    });
    expect(
      adapter.accepts({
        source: "irc",
        thread: "t",
        address: { channel: "#ops\r\nQUIT" },
      })
    ).toBe(false);
  });
});
