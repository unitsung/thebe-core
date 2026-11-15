import { describe, expect, it } from "vitest";
import {
  chunkTelegramText,
  createTelegramImAdapter,
  telegramCursorIdentity,
  validateTelegramCredentials,
} from "./telegram.ts";
import type { ImInbound, ImSendInput } from "../../agent/im/types.ts";

type FetchCall = {
  url: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
};

function jsonBody(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(handler: (call: FetchCall) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {},
      ...(init?.signal ? { signal: init.signal } : {}),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function messageUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 100,
    message: {
      message_id: 5,
      date: 1_760_000_000,
      text: "hello",
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, username: "owner" },
      ...overrides,
    },
  };
}

async function waitFor(
  check: () => boolean,
  label = "condition"
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function adapterWith(
  response: (call: FetchCall) => Promise<Response> | Response,
  options: {
    cursor?: string;
    onInbound?: (message: ImInbound) => void;
    onCursor?: (cursor: string) => void;
    onError?: (message: string) => void;
  } = {}
) {
  const fake = fakeFetch(response);
  const adapter = createTelegramImAdapter({
    account: {
      id: "im-telegram-test",
      platform: "telegram",
      label: "Telegram",
      enabled: true,
      createdAt: "2026-11-15T00:00:00.000Z",
    },
    credentials: { token: "test-token" },
    ...(options.cursor ? { cursor: options.cursor } : {}),
    onCursor: options.onCursor ?? (() => {}),
    ...(options.onError ? { onError: options.onError } : {}),
    fetch: fake.fetch,
    apiBase: "https://telegram.test",
    now: () => new Date("2026-11-15T10:00:00.000Z"),
  });
  if (options.onInbound)
    adapter.onInbound(async (message) => options.onInbound!(message));
  return { adapter, ...fake };
}

describe("Telegram IM adapter", () => {
  it("long-polls from the persisted update id, delivers the text, and advances the cursor", async () => {
    const updates: ImInbound[] = [];
    let first = true;
    const { adapter, calls } = adapterWith(
      (call) => {
        if (call.url.endsWith("/getUpdates") && first) {
          first = false;
          return jsonBody({ ok: true, result: [messageUpdate()] });
        }
        return new Promise<Response>((_, reject) => {
          call.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      },
      {
        cursor: "90",
        onInbound: (message) => updates.push(message),
        onCursor: (cursor) => {
          expect(cursor).toBe("101");
        },
      }
    );
    await adapter.start();
    await waitFor(() => updates.length === 1, "inbound message");
    expect(calls[0]).toMatchObject({
      url: "https://telegram.test/bottest-token/getUpdates",
      body: { offset: 90, timeout: 50, allowed_updates: ["message"] },
    });
    expect(updates[0]).toMatchObject({
      platform: "telegram",
      accountId: "im-telegram-test",
      chat: { kind: "direct", id: "42", title: "@owner" },
      sender: { id: "42", name: "owner" },
      messageId: "5",
      updateId: "100",
      text: "hello",
      replyTo: "5",
    });
    await adapter.stop();
    expect((await adapter.health()).state).toBe("stopped");
  });

  it("reports truthful capabilities", () => {
    const { adapter } = adapterWith(() => jsonBody({ ok: true, result: [] }));
    expect(adapter.capabilities).toMatchObject({
      proactive: true,
      replyOnly: false,
      media: false,
      markdown: false,
      threads: true,
      typing: false,
    });
  });

  it("keeps a forum thread on inbound and outbound messages", async () => {
    const updates: ImInbound[] = [];
    let first = true;
    const { adapter, calls } = adapterWith(
      (call) => {
        if (call.url.endsWith("/getUpdates") && first) {
          first = false;
          return jsonBody({
            ok: true,
            result: [
              messageUpdate({
                message_thread_id: 77,
                chat: { id: -100, type: "supergroup", title: "Group" },
                from: { id: 7, is_bot: false, username: "member" },
              }),
            ],
          });
        }
        if (call.url.endsWith("/sendMessage")) {
          return jsonBody({ ok: true, result: { message_id: 901 } });
        }
        return new Promise<Response>((_, reject) => {
          call.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      },
      { onInbound: (message) => updates.push(message) }
    );
    await adapter.start();
    await waitFor(() => updates.length === 1, "threaded inbound");
    expect(updates[0]!.chat).toMatchObject({
      kind: "group",
      id: "-100",
      threadId: "77",
    });
    const result = await adapter.send({
      platform: "telegram",
      accountId: "im-telegram-test",
      chat: { kind: "group", id: "-100", threadId: "77" },
      text: "threaded reply",
      mode: "reply",
      idempotencyKey: "threaded",
    });
    expect(result).toEqual({ status: "sent", platformMessageId: "901" });
    expect(calls.at(-1)!.body).toMatchObject({
      chat_id: "-100",
      message_thread_id: 77,
    });
    await adapter.stop();
  });

  it("ignores bot and non-text updates without delivering them", async () => {
    const updates: ImInbound[] = [];
    let first = true;
    const { adapter } = adapterWith(
      (call) => {
        if (call.url.endsWith("/getUpdates") && first) {
          first = false;
          return jsonBody({
            ok: true,
            result: [
              messageUpdate({ from: { id: 1, is_bot: true } }),
              { update_id: 101, edited_message: messageUpdate().message },
              {
                update_id: 102,
                message: { ...messageUpdate().message, text: undefined },
              },
            ],
          });
        }
        return new Promise<Response>((_, reject) => {
          call.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      },
      { onInbound: (message) => updates.push(message) }
    );
    await adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updates).toEqual([]);
    await adapter.stop();
  });

  it("chunks long text under the Telegram limit and replies only on the first chunk", async () => {
    const { adapter, calls } = adapterWith(() =>
      jsonBody({ ok: true, result: { message_id: 900 } })
    );
    const input: ImSendInput = {
      platform: "telegram",
      accountId: "im-telegram-test",
      chat: { kind: "direct", id: "42" },
      text: "a".repeat(9_000),
      mode: "reply",
      replyTo: "5",
      idempotencyKey: "long",
    };
    const result = await adapter.send(input);
    expect(result).toEqual({ status: "sent", platformMessageId: "900" });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect((call.body.text as string).length).toBeLessThanOrEqual(4_096);
      expect(call.body.link_preview_options).toEqual({ is_disabled: true });
    }
    expect(calls[0]!.body.reply_parameters).toEqual({
      message_id: 5,
      allow_sending_without_reply: true,
    });
    expect(calls[1]!.body.reply_parameters).toBeUndefined();
    expect(calls[0]!.body.text).toContain("(1/3)");
    expect(calls[2]!.body.text).toContain("(3/3)");
  });

  it("returns retry with the platform retry-after instead of blocking on a long 429 window", async () => {
    const { adapter } = adapterWith(() =>
      jsonBody(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 120 },
        },
        429
      )
    );
    const result = await adapter.send({
      platform: "telegram",
      accountId: "im-telegram-test",
      chat: { kind: "direct", id: "42" },
      text: "hello",
      mode: "proactive",
      idempotencyKey: "rate-limited",
    });
    expect(result).toMatchObject({
      status: "retry",
      retryAfterMs: 120_000,
    });
  });

  it("stops polling after a 409 conflict without exposing the token", async () => {
    const errors: string[] = [];
    const { adapter, calls } = adapterWith(
      () =>
        jsonBody({ ok: false, error_code: 409, description: "Conflict" }, 409),
      { onError: (message) => errors.push(message) }
    );
    await adapter.start();
    await waitFor(() => errors.length === 1, "conflict");
    expect(calls).toHaveLength(1);
    expect(errors[0]).toContain("409");
    expect(errors[0]).not.toContain("test-token");
    expect((await adapter.health()).state).toBe("error");
    await adapter.stop();
    expect((await adapter.health()).state).toBe("stopped");
  });

  it("reports needs_login when Telegram rejects the bot token", async () => {
    const { adapter, calls } = adapterWith(() =>
      jsonBody({ ok: false, error_code: 401, description: "Unauthorized" }, 401)
    );
    await adapter.start();
    await waitFor(() => calls.length === 1, "authorization failure");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
    expect(await adapter.health()).toEqual({
      state: "needs_login",
      detail: "Telegram rejected the bot token",
    });
    await adapter.stop();
  });

  it("keeps a plain-text user message plain even when it contains Markdown", async () => {
    const { adapter, calls } = adapterWith(() =>
      jsonBody({ ok: true, result: { message_id: 1 } })
    );
    await adapter.send({
      platform: "telegram",
      accountId: "im-telegram-test",
      chat: { kind: "direct", id: "42" },
      text: "**not bold** _not italic_",
      mode: "proactive",
      idempotencyKey: "plain",
    });
    expect(calls[0]!.body.parse_mode).toBeUndefined();
    expect(calls[0]!.body.text).toBe("**not bold** _not italic_");
  });
});

describe("Telegram credentials", () => {
  it("validates the token without exposing it", () => {
    expect(
      validateTelegramCredentials({ token: "123456:ABC_def-ghi" })
    ).toBeUndefined();
    expect(validateTelegramCredentials({ token: "" })).toContain("missing");
    expect(validateTelegramCredentials({ token: "bad token" })).toContain(
      "spaces"
    );
  });

  it("derives a stable cursor identity that is not the token", () => {
    const identity = telegramCursorIdentity({ token: "123456:ABC_def-ghi" });
    expect(identity).toBeTruthy();
    expect(identity).toBe(
      telegramCursorIdentity({ token: "123456:ABC_def-ghi" })
    );
    expect(identity).not.toBe(
      telegramCursorIdentity({ token: "123456:XYZ_def-ghi" })
    );
    expect(identity).not.toContain("ABC_def-ghi");
  });
});

describe("chunkTelegramText", () => {
  it("leaves short text alone and marks multiple chunks", () => {
    expect(chunkTelegramText("short")).toEqual(["short"]);
    const chunks = chunkTelegramText("x".repeat(10_000));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain("(1/3)");
    expect(chunks.every((chunk) => chunk.length <= 4_096)).toBe(true);
  });

  it("does not split a surrogate pair", () => {
    const text = "😀".repeat(3_000);
    const chunks = chunkTelegramText(text);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });
});
