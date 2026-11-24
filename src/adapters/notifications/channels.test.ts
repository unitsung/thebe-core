import { describe, expect, it } from "vitest";
import type {
  Notification,
  NotificationSendInput,
  NotificationTarget,
} from "../../agent/notifications/types.ts";
import { createAppriseNotificationAdapter } from "./apprise.ts";
import { createBarkNotificationAdapter } from "./bark.ts";
import { createBlueBubblesNotificationAdapter } from "./bluebubbles.ts";
import { createFeishuWebhookNotificationAdapter } from "./feishu-webhook.ts";
import { createGoogleChatNotificationAdapter } from "./googlechat.ts";
import { createGotifyNotificationAdapter } from "./gotify.ts";
import { createMatrixNotificationAdapter } from "./matrix.ts";
import { createNtfyNotificationAdapter } from "./ntfy.ts";
import { createPushoverNotificationAdapter } from "./pushover.ts";
import { createSignalNotificationAdapter } from "./signal.ts";
import { createTeamsNotificationAdapter } from "./teams.ts";
import { createTwilioNotificationAdapter } from "./twilio.ts";
import { createWhatsAppNotificationAdapter } from "./whatsapp.ts";

const SENDER = "15550104";
const FIRST = "15550103";
const SECOND = "15550102";
const TOKEN = "unitTestMatrixToken";
const BARK_KEY = "unitTestBarkKey";
const PUSHOVER_USER = "unitTestPushoverUser0000";
const APPRISE_TOKEN = "appriseTestKey";

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

describe("ntfy notification adapter", () => {
  it("publishes JSON to the topic with its priority and deep link", async () => {
    const { fetcher, calls } = capture(response(200, { id: "m1" }));
    const adapter = createNtfyNotificationAdapter({ fetch: fetcher });
    const address = { url: "https://ntfy.example/ops", token: TOKEN };
    expect(adapter.accepts({ source: "ntfy", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("ntfy", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe("https://ntfy.example");
    expect(headers(calls[0]!)).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "idempotency-key": "idem-1",
    });
    expect(jsonBody(calls[0]!)).toMatchObject({
      topic: "ops",
      title: "Thebe",
      priority: 5,
      click: "thebe://goal/42",
      tags: ["attention"],
    });
    expect(String(jsonBody(calls[0]!).message)).toContain("thebe://goal/42");
  });

  it("uses a configured topic on a self-hosted server and refuses a missing one", async () => {
    const { fetcher, calls } = capture(response(200, { id: "m1" }));
    const adapter = createNtfyNotificationAdapter({ fetch: fetcher });
    await adapter.send(
      input("ntfy", { url: "https://push.example/ntfy", topic: "thebe" })
    );
    expect(calls[0]!.url).toBe("https://push.example/ntfy");
    expect(
      adapter.accepts({
        source: "ntfy",
        thread: "t",
        address: { url: "https://ntfy.example" },
      })
    ).toBe(false);
  });
});

describe("Bark notification adapter", () => {
  it("posts to the device key and uses the time-sensitive level", async () => {
    const { fetcher, calls } = capture(response(200, { code: 200 }));
    const adapter = createBarkNotificationAdapter({ fetch: fetcher });
    const address = {
      deviceKey: BARK_KEY,
      server: "https://bark.example",
    };
    expect(adapter.accepts({ source: "bark", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("bark", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe(`https://bark.example/${BARK_KEY}`);
    expect(jsonBody(calls[0]!)).toMatchObject({
      title: "Thebe",
      group: "thebe",
      level: "timeSensitive",
      url: "thebe://goal/42",
    });
  });

  it("treats a JSON refusal as discard and rejects a malformed key", async () => {
    const { fetcher } = capture(
      response(200, { code: 400, message: "invalid device key" })
    );
    const adapter = createBarkNotificationAdapter({ fetch: fetcher });
    expect(
      await adapter.send(input("bark", { deviceKey: BARK_KEY }))
    ).toMatchObject({ status: "discard" });
    expect(
      adapter.accepts({
        source: "bark",
        thread: "t",
        address: { deviceKey: "../../etc/passwd" },
      })
    ).toBe(false);
  });
});

describe("Feishu webhook notification adapter", () => {
  it("signs the request when a secret is configured", async () => {
    const { fetcher, calls } = capture(response(200, { code: 0 }));
    const adapter = createFeishuWebhookNotificationAdapter({
      fetch: fetcher,
      secret: "signing-secret",
    });
    expect(
      await adapter.send(
        input("feishu-webhook", { url: "https://open.feishu.cn/hook/x" })
      )
    ).toEqual({ status: "sent" });
    const body = jsonBody(calls[0]!);
    expect(body).toMatchObject({ msg_type: "text" });
    expect(typeof body.timestamp).toBe("string");
    expect(typeof body.sign).toBe("string");
    expect(String((body.content as Record<string, string>).text)).toContain(
      "thebe://goal/42"
    );
  });

  it("classifies a platform-level refusal as discard and a rate limit as retry", async () => {
    const refused = createFeishuWebhookNotificationAdapter({
      fetch: async () => response(200, { code: 19021, msg: "sign match fail" }),
    });
    expect(
      await refused.send(
        input("feishu-webhook", { url: "https://open.feishu.cn/hook/x" })
      )
    ).toMatchObject({ status: "discard" });

    const busy = createFeishuWebhookNotificationAdapter({
      fetch: async () => response(200, { code: 11232, msg: "frequency" }),
    });
    expect(
      await busy.send(
        input("feishu-webhook", { url: "https://open.feishu.cn/hook/x" })
      )
    ).toMatchObject({ status: "retry", retryAfterMs: 60_000 });
  });
});

describe("Teams and Google Chat webhook adapters", () => {
  it("sends a MessageCard to Teams", async () => {
    const { fetcher, calls } = capture(response(200, "1"));
    const adapter = createTeamsNotificationAdapter({ fetch: fetcher });
    expect(
      await adapter.send(
        input("teams", { url: "https://outlook.office.com/webhook/x" })
      )
    ).toEqual({ status: "sent" });
    expect(jsonBody(calls[0]!)).toMatchObject({
      "@type": "MessageCard",
      summary: "Thebe",
    });
  });

  it("sends text to Google Chat", async () => {
    const { fetcher, calls } = capture(response(200, {}));
    const adapter = createGoogleChatNotificationAdapter({ fetch: fetcher });
    expect(
      await adapter.send(
        input("googlechat", { url: "https://chat.googleapis.com/v1/spaces/x" })
      )
    ).toEqual({ status: "sent" });
    expect(jsonBody(calls[0]!)).toEqual({
      text: "Thebe\nSomething needs you.\nthebe://goal/42",
    });
  });

  it("rejects a non-http webhook", () => {
    const adapter = createGoogleChatNotificationAdapter({});
    expect(
      adapter.accepts({
        source: "googlechat",
        thread: "t",
        address: { url: "file:///etc/passwd" },
      })
    ).toBe(false);
  });
});

describe("Pushover notification adapter", () => {
  it("sends form fields with the high priority and a supplementary URL", async () => {
    const { fetcher, calls } = capture(response(200, { status: 1 }));
    const adapter = createPushoverNotificationAdapter({
      token: "app-token",
      fetch: fetcher,
    });
    const address = { user: PUSHOVER_USER };
    expect(adapter.accepts({ source: "pushover", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("pushover", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe("https://api.pushover.net/1/messages.json");
    expect(headers(calls[0]!)).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("token")).toBe("app-token");
    expect(form.get("user")).toBe(PUSHOVER_USER);
    expect(form.get("priority")).toBe("1");
    expect(form.get("url")).toBe("thebe://goal/42");
  });

  it("reports a validation failure as discard", async () => {
    const adapter = createPushoverNotificationAdapter({
      token: "app-token",
      fetch: async () =>
        response(400, { status: 0, errors: ["user identifier is invalid"] }),
    });
    expect(
      await adapter.send(input("pushover", { user: PUSHOVER_USER }))
    ).toMatchObject({
      status: "discard",
      reason: expect.stringContaining("user identifier"),
    });
  });
});

describe("Gotify notification adapter", () => {
  it("sends the application token in a header", async () => {
    const { fetcher, calls } = capture(response(200, { id: 1 }));
    const adapter = createGotifyNotificationAdapter({
      url: "https://gotify.example",
      fetch: fetcher,
    });
    const address = { token: TOKEN };
    expect(adapter.accepts({ source: "gotify", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("gotify", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe("https://gotify.example/message");
    expect(headers(calls[0]!)["X-Gotify-Key"]).toBe(TOKEN);
    expect(jsonBody(calls[0]!)).toMatchObject({ priority: 8 });
  });
});

describe("Matrix notification adapter", () => {
  it("puts a text event under a deterministic transaction id", async () => {
    const { fetcher, calls } = capture(response(200, { event_id: "$event" }));
    const adapter = createMatrixNotificationAdapter({
      homeserverUrl: "https://matrix.example",
      accessToken: TOKEN,
      fetch: fetcher,
    });
    const address = { roomId: "!ops:matrix.example" };
    expect(adapter.accepts({ source: "matrix", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("matrix", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toMatch(
      /\/_matrix\/client\/v3\/rooms\/!ops%3Amatrix\.example\/send\/m\.room\.message\/[0-9a-f]{64}$/
    );
    expect(calls[0]!.init.method).toBe("PUT");
    expect(headers(calls[0]!).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("honours retry_after_ms on a rate limit", async () => {
    const adapter = createMatrixNotificationAdapter({
      homeserverUrl: "https://matrix.example",
      accessToken: TOKEN,
      fetch: async () =>
        response(429, { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 12_000 }),
    });
    expect(
      await adapter.send(input("matrix", { roomId: "!ops:matrix.example" }))
    ).toMatchObject({ status: "retry", retryAfterMs: 12_000 });
  });
});

describe("Signal notification adapter", () => {
  it("sends through signal-cli-rest-api with the configured number", async () => {
    const { fetcher, calls } = capture(response(201, { timestamp: 1 }));
    const adapter = createSignalNotificationAdapter({
      url: "http://127.0.0.1:8080",
      number: SENDER,
      fetch: fetcher,
    });
    const address = { recipients: `${FIRST},${SECOND}` };
    expect(adapter.accepts({ source: "signal", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("signal", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/v2/send");
    expect(jsonBody(calls[0]!)).toMatchObject({
      number: SENDER,
      recipients: [FIRST, SECOND],
    });
  });

  it("rejects a malformed recipient", () => {
    const adapter = createSignalNotificationAdapter({
      url: "http://127.0.0.1:8080",
      number: SENDER,
    });
    expect(
      adapter.accepts({
        source: "signal",
        thread: "t",
        address: { recipients: "not a phone" },
      })
    ).toBe(false);
  });
});

describe("WhatsApp notification adapter", () => {
  it("sends text to the Cloud API with an idempotency key", async () => {
    const { fetcher, calls } = capture(
      response(200, { messages: [{ id: "wamid" }] })
    );
    const adapter = createWhatsAppNotificationAdapter({
      accessToken: TOKEN,
      phoneNumberId: "123456789",
      fetch: fetcher,
    });
    const address = { to: FIRST };
    expect(adapter.accepts({ source: "whatsapp", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("whatsapp", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe(
      "https://graph.facebook.com/v20.0/123456789/messages"
    );
    expect(headers(calls[0]!).authorization).toBe(`Bearer ${TOKEN}`);
    expect(jsonBody(calls[0]!)).toMatchObject({
      messaging_product: "whatsapp",
      to: FIRST,
      type: "text",
    });
  });

  it("treats a closed conversation window as a permanent refusal", async () => {
    const adapter = createWhatsAppNotificationAdapter({
      accessToken: TOKEN,
      phoneNumberId: "123456789",
      fetch: async () =>
        response(400, {
          error: { message: "Message failed to send", code: 131047 },
        }),
    });
    expect(await adapter.send(input("whatsapp", { to: FIRST }))).toMatchObject({
      status: "discard",
    });
  });
});

describe("Twilio SMS notification adapter", () => {
  it("sends a form request with Basic auth", async () => {
    const { fetcher, calls } = capture(response(201, { sid: "SM1" }));
    const adapter = createTwilioNotificationAdapter({
      accountSid: "AC123",
      authToken: TOKEN,
      from: SENDER,
      fetch: fetcher,
    });
    const address = { to: FIRST };
    expect(adapter.accepts({ source: "twilio", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("twilio", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toContain("/Accounts/AC123/Messages.json");
    expect(headers(calls[0]!).authorization).toMatch(/^Basic /);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("To")).toBe(FIRST);
    expect(form.get("From")).toBe(SENDER);
  });
});

describe("BlueBubbles notification adapter", () => {
  it("sends an iMessage to a chat GUID with a stable temp GUID", async () => {
    const { fetcher, calls } = capture(
      response(200, { status: 200, data: { guid: "GUID" } })
    );
    const adapter = createBlueBubblesNotificationAdapter({
      url: "http://127.0.0.1:1234",
      password: "bb-pass",
      fetch: fetcher,
    });
    const address = { chatGuid: `iMessage;-;${FIRST}` };
    expect(
      adapter.accepts({ source: "bluebubbles", thread: "t", address })
    ).toBe(true);
    expect(await adapter.send(input("bluebubbles", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toContain("/api/v1/message/text?password=");
    const body = jsonBody(calls[0]!);
    expect(body.chatGuid).toBe(`iMessage;-;${FIRST}`);
    expect(body.tempGuid).toMatch(/^[0-9a-f]{64}$/);
    expect(body.method).toBe("apple-script");
  });

  it("reports a BlueBubbles-level error as discard", async () => {
    const adapter = createBlueBubblesNotificationAdapter({
      url: "http://127.0.0.1:1234",
      password: "bb-pass",
      fetch: async () =>
        response(200, { status: 400, message: "no chat with that GUID" }),
    });
    expect(
      await adapter.send(
        input("bluebubbles", { chatGuid: `iMessage;-;${FIRST}` })
      )
    ).toMatchObject({ status: "discard" });
  });
});

describe("Apprise notification adapter", () => {
  it("posts the notice to a saved configuration token", async () => {
    const { fetcher, calls } = capture(response(200, { success: true }));
    const adapter = createAppriseNotificationAdapter({
      url: "https://apprise.example",
      fetch: fetcher,
    });
    const address = { token: APPRISE_TOKEN };
    expect(adapter.accepts({ source: "apprise", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input("apprise", address))).toEqual({
      status: "sent",
    });
    expect(calls[0]!.url).toBe(
      `https://apprise.example/notify/${APPRISE_TOKEN}`
    );
    expect(jsonBody(calls[0]!)).toMatchObject({
      title: "Thebe",
      type: "failure",
      format: "text",
    });
  });

  it("retries when Apprise cannot reach every destination", async () => {
    const adapter = createAppriseNotificationAdapter({
      url: "https://apprise.example",
      token: APPRISE_TOKEN,
      fetch: async () => response(424, "one or more notifications failed"),
    });
    expect(await adapter.send(input("apprise", {}))).toMatchObject({
      status: "retry",
    });
  });

  it("requires a configuration token", () => {
    const adapter = createAppriseNotificationAdapter({
      url: "https://apprise.example",
    });
    expect(
      adapter.accepts({
        source: "apprise",
        thread: "t",
        address: { token: "bad key!" },
      })
    ).toBe(false);
  });
});
