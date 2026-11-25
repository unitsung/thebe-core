import { describe, expect, it } from "vitest";
import {
  QQ_MAX_TEXT,
  chunkQqText,
  createQqImAdapter,
  qqCursorIdentity,
  validateQqCredentials,
  type QqWebSocket,
  type QqSocketFactory,
} from "./qq.ts";
import type { ImInbound } from "../../agent/im/types.ts";

type FetchCall = {
  url: string;
  method: string;
  body: Record<string, unknown>;
  authorization?: string;
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
    const headers = new Headers(init?.headers);
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {},
      ...(headers.get("authorization")
        ? { authorization: headers.get("authorization")! }
        : {}),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

class FakeSocket implements QqWebSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closed = true;
    this.onclose?.({ code, reason });
  }

  emit(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

function socketFactory(sockets: FakeSocket[]): QqSocketFactory {
  return (url) => {
    expect(url).toBe("wss://qq.test/ws");
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
}

function setup(options: { now?: () => Date } = {}) {
  const sockets: FakeSocket[] = [];
  let clock = options.now ? options.now() : new Date("2026-11-18T10:00:00Z");
  const now = () => clock;
  const fake = fakeFetch((call) => {
    if (call.url.endsWith("/app/getAppAccessToken")) {
      return jsonBody({ access_token: "qq-access", expires_in: "7200" });
    }
    if (call.url.endsWith("/gateway/bot")) {
      return jsonBody({ url: "wss://qq.test/ws" });
    }
    if (call.url.endsWith("/messages")) {
      return jsonBody({ id: `out-${fake.calls.length}` });
    }
    if (call.url.endsWith("/files")) {
      return jsonBody({ file_info: "qq-file-info" });
    }
    if (call.url.endsWith("/photo.png")) {
      return new Response(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        { headers: { "content-type": "image/png" } }
      );
    }
    if (call.method === "DELETE") return jsonBody({});
    return jsonBody({ message: "not found" }, 404);
  });
  const inbound: ImInbound[] = [];
  const adapter = createQqImAdapter({
    account: {
      id: "im-qq-test",
      platform: "qq",
      label: "QQ",
      enabled: true,
      createdAt: "2026-11-18T00:00:00Z",
    },
    credentials: { appId: "102030", clientSecret: "qq-secret" },
    onCursor: () => {},
    fetch: fake.fetch,
    now,
    apiBase: "https://qq.test",
    tokenUrl: "https://qq.test/app/getAppAccessToken",
    socketFactory: socketFactory(sockets),
  });
  adapter.onInbound(async (message) => {
    inbound.push(message);
  });
  return {
    adapter,
    sockets,
    calls: fake.calls,
    inbound,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

function message(
  type: string,
  data: Record<string, unknown>,
  sequence: number
): Record<string, unknown> {
  return { op: 0, s: sequence, t: type, d: data };
}

async function waitFor(
  check: () => boolean,
  label = "condition"
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function sentPayload(socket: FakeSocket, op: number) {
  return socket.sent
    .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    .find((entry) => entry.op === op);
}

describe("QQ IM adapter", () => {
  it("reports a separate direct and group reply window", () => {
    const { adapter } = setup();
    expect(adapter.replyWindowMsFor?.({ kind: "direct", id: "user-1" })).toBe(
      60 * 60_000
    );
    expect(adapter.replyWindowMsFor?.({ kind: "group", id: "group-1" })).toBe(
      5 * 60_000
    );
  });

  it("identifies, receives a C2C message, and replies with msg_id/msg_seq", async () => {
    const context = setup();
    const socket = await (async () => {
      await context.adapter.start();
      await waitFor(() => context.sockets.length === 1, "socket");
      return context.sockets[0]!;
    })();
    socket.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
    await waitFor(() => sentPayload(socket, 2) !== undefined, "identify");
    expect(sentPayload(socket, 2)?.d).toMatchObject({
      token: "QQBot qq-access",
      intents: 1 << 25,
      shard: [0, 1],
    });
    socket.emit(message("READY", { session_id: "session-1" }, 1));
    await waitFor(() => context.sockets.length === 1, "ready");
    socket.emit(
      message(
        "C2C_MESSAGE_CREATE",
        {
          id: "qq-msg-1",
          author: { user_openid: "user-1", username: "Owner" },
          content: "hello",
          timestamp: "2026-11-18T10:00:00Z",
        },
        2
      )
    );
    await waitFor(() => context.inbound.length === 1, "inbound");
    expect(context.inbound[0]).toMatchObject({
      platform: "qq",
      accountId: "im-qq-test",
      chat: { kind: "direct", id: "user-1" },
      sender: { id: "user-1", name: "Owner" },
      messageId: "qq-msg-1",
      text: "hello",
      replyTo: "qq-msg-1",
    });

    const first = await context.adapter.send({
      platform: "qq",
      accountId: "im-qq-test",
      chat: { kind: "direct", id: "user-1" },
      text: "reply",
      mode: "reply",
      replyTo: "qq-msg-1",
      idempotencyKey: "reply-1",
    });
    expect(first.status).toBe("sent");
    const sendCall = context.calls.find((call) =>
      call.url.endsWith("/v2/users/user-1/messages")
    );
    expect(sendCall?.authorization).toBe("QQBot qq-access");
    expect(sendCall?.body).toEqual({
      content: "reply",
      msg_type: 0,
      msg_id: "qq-msg-1",
      msg_seq: 1,
    });

    // A QQ redelivery with the same msg_id must not reset the reply sequence.
    socket.emit(
      message(
        "C2C_MESSAGE_CREATE",
        {
          id: "qq-msg-1",
          author: { user_openid: "user-1", username: "Owner" },
          content: "hello",
          timestamp: "2026-11-18T10:00:00Z",
        },
        3
      )
    );
    await waitFor(() => context.inbound.length === 2, "redelivery");
    await context.adapter.send({
      platform: "qq",
      accountId: "im-qq-test",
      chat: { kind: "direct", id: "user-1" },
      text: "again",
      mode: "reply",
      replyTo: "qq-msg-1",
      idempotencyKey: "reply-2",
    });
    const sends = context.calls.filter((call) =>
      call.url.endsWith("/v2/users/user-1/messages")
    );
    expect(sends[1]?.body.msg_seq).toBe(2);
    await context.adapter.stop();
  });

  it("receives a group @ message and replies on the group endpoint", async () => {
    const context = setup();
    await context.adapter.start();
    await waitFor(() => context.sockets.length === 1, "socket");
    const socket = context.sockets[0]!;
    socket.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
    socket.emit(message("READY", { session_id: "session-1" }, 1));
    socket.emit(
      message(
        "GROUP_AT_MESSAGE_CREATE",
        {
          id: "group-msg-1",
          group_openid: "group-1",
          author: { member_openid: "member-1", username: "Alice" },
          content: "question",
          timestamp: "2026-11-18T10:00:00Z",
        },
        2
      )
    );
    await waitFor(() => context.inbound.length === 1, "inbound");
    expect(context.inbound[0]).toMatchObject({
      chat: { kind: "group", id: "group-1" },
      sender: { id: "member-1", name: "Alice" },
      text: "question",
    });
    const result = await context.adapter.send({
      platform: "qq",
      accountId: "im-qq-test",
      chat: { kind: "group", id: "group-1" },
      text: "answer",
      mode: "reply",
      replyTo: "group-msg-1",
      idempotencyKey: "group-reply",
    });
    expect(result.status).toBe("sent");
    expect(
      context.calls.find((call) =>
        call.url.endsWith("/v2/groups/group-1/messages")
      )?.body
    ).toEqual({
      content: "answer",
      msg_type: 0,
      msg_id: "group-msg-1",
      msg_seq: 1,
    });
    await context.adapter.stop();
  });

  it("recalls a group message through the official DELETE endpoint", async () => {
    const context = setup();

    const result = await context.adapter.recall?.({
      platform: "qq",
      accountId: "im-qq-test",
      chat: { kind: "group", id: "group-1" },
      messageId: "out-7",
    });

    expect(result).toEqual({ status: "recalled" });
    expect(
      context.calls.find((call) => call.method === "DELETE")
    ).toMatchObject({
      url: "https://qq.test/v2/groups/group-1/messages/out-7",
      authorization: "QQBot qq-access",
    });
    expect(context.adapter.capabilities.recall).toBe(true);
  });

  it("downloads inbound media from an official QQ host", async () => {
    const context = setup();
    const fetched = await context.adapter.fetchMedia?.({
      accountId: "im-qq-test",
      chat: { kind: "group", id: "group-1" },
      messageId: "qq-msg-1",
      media: {
        kind: "image",
        id: "https://multimedia.nt.qq.com.cn/photo.png",
        mimeType: "image/png",
      },
    });
    expect(fetched?.mediaType).toBe("image/png");
    expect(fetched?.data).toHaveLength(8);
    expect(
      context.calls.find((call) => call.url.endsWith("/photo.png"))
        ?.authorization
    ).toBeUndefined();
    expect(context.adapter.capabilities.media).toBe(true);
  });

  it("uploads rich media and sends it as a passive reply", async () => {
    const context = setup();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).toString("base64");
    const result = await context.adapter.send({
      platform: "qq",
      accountId: "im-qq-test",
      chat: { kind: "group", id: "group-1" },
      text: "chart",
      media: [
        {
          kind: "image",
          mediaType: "image/png",
          data: png,
          filename: "chart.png",
        },
      ],
      mode: "reply",
      replyTo: "qq-msg-1",
      idempotencyKey: "media-1",
    });
    expect(result.status).toBe("sent");
    expect(
      context.calls.find((call) => call.url.endsWith("/files"))?.body
    ).toMatchObject({
      file_type: 1,
      file_data: png,
      file_name: "chart.png",
      srv_send_msg: false,
    });
    expect(
      context.calls.find((call) =>
        call.url.endsWith("/v2/groups/group-1/messages")
      )?.body
    ).toMatchObject({
      content: "chart",
      msg_type: 7,
      media: { file_info: "qq-file-info" },
      msg_id: "qq-msg-1",
      msg_seq: 1,
    });
  });

  it("drops a proactive send and a reply whose window has closed", async () => {
    const context = setup();
    await context.adapter.start();
    await waitFor(() => context.sockets.length === 1, "socket");
    const socket = context.sockets[0]!;
    socket.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
    socket.emit(message("READY", { session_id: "session-1" }, 1));
    socket.emit(
      message(
        "C2C_MESSAGE_CREATE",
        {
          id: "qq-msg-2",
          author: { user_openid: "user-2" },
          content: "hello",
          timestamp: "2026-11-18T10:00:00Z",
        },
        2
      )
    );
    await waitFor(() => context.inbound.length === 1, "inbound");

    const proactive = await context.adapter.send({
      platform: "qq",
      accountId: "im-qq-test",
      chat: { kind: "direct", id: "user-2" },
      text: "push",
      mode: "proactive",
      idempotencyKey: "push",
    });
    expect(proactive).toEqual({
      status: "discard",
      reason: "proactive_not_supported",
    });

    context.advance(61 * 60_000);
    const expired = await context.adapter.send({
      platform: "qq",
      accountId: "im-qq-test",
      chat: { kind: "direct", id: "user-2" },
      text: "late",
      mode: "reply",
      replyTo: "qq-msg-2",
      idempotencyKey: "late",
    });
    expect(expired).toEqual({ status: "discard", reason: "window_closed" });
    expect(context.calls.some((call) => call.url.endsWith("/messages"))).toBe(
      false
    );
    await context.adapter.stop();
  });

  it("reconnects with RESUME after the gateway closes a ready session", async () => {
    const context = setup();
    await context.adapter.start();
    await waitFor(() => context.sockets.length === 1, "socket");
    const first = context.sockets[0]!;
    first.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
    first.emit(message("READY", { session_id: "session-1" }, 7));
    first.close(4000, "server reconnect");
    await waitFor(() => context.sockets.length === 2, "reconnected socket");
    const second = context.sockets[1]!;
    second.emit({ op: 10, d: { heartbeat_interval: 45_000 } });
    await waitFor(() => sentPayload(second, 6) !== undefined, "resume");
    expect(sentPayload(second, 6)?.d).toMatchObject({
      token: "QQBot qq-access",
      session_id: "session-1",
      seq: 7,
    });
    await context.adapter.stop();
  });

  it("caches the access token and validates credentials", async () => {
    const context = setup();
    await context.adapter.start();
    await waitFor(() => context.sockets.length === 1, "socket");
    await context.adapter.stop();
    const tokenCalls = context.calls.filter((call) =>
      call.url.endsWith("/app/getAppAccessToken")
    );
    expect(tokenCalls.length).toBe(1);
    expect(validateQqCredentials({ appId: "1", clientSecret: "s" })).toBe(
      undefined
    );
    expect(validateQqCredentials({ appId: "", clientSecret: "s" })).toBe(
      "missing credential: appId"
    );
    expect(qqCursorIdentity({ appId: "1" })).toBe(
      qqCursorIdentity({ appId: "1" })
    );
  });
});

describe("QQ chunking", () => {
  it("keeps the (n/m) marker inside the platform limit", () => {
    const parts = chunkQqText("x".repeat(QQ_MAX_TEXT + 500));
    expect(parts.length).toBe(2);
    expect(parts[0]!.length).toBeLessThanOrEqual(QQ_MAX_TEXT);
    expect(parts[0]).toContain("(1/2)");
    expect(parts[1]).toContain("(2/2)");
  });

  it("caps a reply at the platform's reply count", () => {
    const parts = chunkQqText("x".repeat(QQ_MAX_TEXT * 10), QQ_MAX_TEXT, 2);
    expect(parts.length).toBe(2);
    expect(parts[1]).toContain("(2/2)");
  });
});
