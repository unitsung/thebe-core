import { describe, expect, it } from "vitest";
import {
  IMESSAGE_MAX_TEXT,
  createImessageImAdapter,
  imessageBaseUrl,
  imessageCursorIdentity,
  truncateImessageText,
  validateImessageCredentials,
} from "./imessage.ts";
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

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    guid: "message-1",
    text: "hello",
    isFromMe: false,
    associatedMessageGuid: null,
    associatedMessageType: null,
    dateCreated: 2_000,
    handle: { address: "+15550100", service: "iMessage" },
    chats: [
      {
        guid: "iMessage;-;+15550100",
        chatIdentifier: "+15550100",
        displayName: "",
      },
    ],
    ...overrides,
  };
}

function messageMilliseconds(row: Record<string, unknown>): number | undefined {
  const raw = Number(row.dateCreated);
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return raw < 1_000_000_000_000 ? raw * 1_000 : raw;
}

function setup(
  options: {
    cursor?: string;
    rows?: Record<string, unknown>[];
    response?: (call: FetchCall) => Promise<Response> | Response;
  } = {}
) {
  const inbound: ImInbound[] = [];
  const cursors: string[] = [];
  let rows = options.rows ?? [];
  let baseline = 1_000;
  const fake = fakeFetch((call) => {
    if (options.response) {
      const custom = options.response(call);
      if (custom) return custom;
    }
    if (call.url.includes("/api/v1/message/query")) {
      if (call.body.sort === "DESC") {
        return jsonBody({
          status: 200,
          data: [{ dateCreated: baseline }],
        });
      }
      const after =
        typeof call.body.after === "number" ? call.body.after : undefined;
      return jsonBody({
        status: 200,
        data:
          after === undefined
            ? rows
            : rows.filter((row) => (messageMilliseconds(row) ?? 0) > after),
      });
    }
    if (call.url.includes("/api/v1/message/text")) {
      return jsonBody({
        status: 200,
        message: "Message sent!",
        data: { guid: "sent-1" },
      });
    }
    if (call.url.includes("/api/v1/ping")) {
      return jsonBody({ status: 200 });
    }
    return jsonBody({ status: 404, message: "not found" }, 404);
  });
  const adapter = createImessageImAdapter({
    account: {
      id: "im-imessage-test",
      platform: "imessage",
      label: "iMessage",
      enabled: true,
      createdAt: "2026-11-18T00:00:00Z",
    },
    credentials: {
      baseUrl: "https://bluebubbles.test",
      password: "blue-secret",
    },
    ...(options.cursor ? { cursor: options.cursor } : {}),
    onCursor: (cursor) => cursors.push(cursor),
    fetch: fake.fetch,
    now: () => new Date("2026-11-18T10:00:00Z"),
    pollIntervalMs: 5,
    requestTimeoutMs: 200,
  });
  adapter.onInbound(async (message) => {
    inbound.push(message);
  });
  return {
    adapter,
    calls: fake.calls,
    inbound,
    cursors,
    setRows(next: Record<string, unknown>[]) {
      rows = next;
    },
    setBaseline(next: number) {
      baseline = next;
    },
  };
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label = "condition"
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("iMessage (BlueBubbles) IM adapter", () => {
  it("baselines once, then delivers a direct message and advances the cursor", async () => {
    const context = setup();
    await context.adapter.start();
    await waitFor(
      () => context.calls.some((call) => call.body.sort === "DESC"),
      "baseline"
    );
    context.setRows([messageRow()]);
    await waitFor(() => context.inbound.length === 1, "inbound");
    expect(context.inbound[0]).toMatchObject({
      platform: "imessage",
      accountId: "im-imessage-test",
      chat: { kind: "direct", id: "iMessage;-;+15550100" },
      sender: { id: "+15550100" },
      messageId: "message-1",
      text: "hello",
      replyTo: "message-1",
    });
    expect(context.cursors.at(-1)).toBe("2000000");
    const query = context.calls.find(
      (call) =>
        call.url.includes("/api/v1/message/query") && call.body.sort === "ASC"
    );
    expect(query?.authorization).toBe("blue-secret");
    expect(query?.body.with).toEqual(["chats"]);
    expect(new URL(query!.url).searchParams.get("password")).toBeNull();
    await context.adapter.stop();
  });

  it("resumes from a stored cursor without taking a new baseline", async () => {
    const context = setup({ cursor: "2000000" });
    await context.adapter.start();
    await waitFor(
      () => context.calls.some((call) => call.body.after === 2_000_000),
      "query after cursor"
    );
    expect(context.calls.some((call) => call.body.sort === "DESC")).toBe(false);
    await context.adapter.stop();
  });

  it("delivers every message that shares the polled millisecond", async () => {
    const context = setup({ cursor: "2000000" });
    await context.adapter.start();
    await waitFor(
      () => context.calls.some((call) => call.body.after === 2_000_000),
      "query after cursor"
    );
    context.setRows([
      messageRow({ guid: "same-ms-1", dateCreated: 2_000_100 }),
      messageRow({ guid: "same-ms-2", dateCreated: 2_000_100 }),
    ]);
    await waitFor(() => context.inbound.length >= 1, "first inbound");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.inbound.map((message) => message.messageId)).toEqual([
      "same-ms-1",
      "same-ms-2",
    ]);
    expect(context.cursors.at(-1)).toBe("2000100000");
    await context.adapter.stop();
  });

  it("keeps a group chat as a group and skips own and tapback messages", async () => {
    const context = setup();
    await context.adapter.start();
    await waitFor(() =>
      context.calls.some((call) => call.body.sort === "DESC")
    );
    context.setRows([
      messageRow({ guid: "own", isFromMe: true, dateCreated: 2_000 }),
      messageRow({
        guid: "tapback",
        associatedMessageType: "Liked",
        associatedMessageGuid: "message-1",
        dateCreated: 2_001,
      }),
      messageRow({
        guid: "group-1",
        dateCreated: 2_002,
        chats: [
          {
            guid: "iMessage;+;chat123",
            chatIdentifier: "Family",
            displayName: "Family",
          },
        ],
      }),
    ]);
    await waitFor(() => context.inbound.length === 1, "group inbound");
    expect(context.inbound[0]).toMatchObject({
      chat: { kind: "group", id: "iMessage;+;chat123", title: "Family" },
      text: "hello",
    });
    await context.adapter.stop();
  });

  it("sends a text through the BlueBubbles REST API with a stable tempGuid", async () => {
    const context = setup();
    await context.adapter.start();
    await waitFor(() =>
      context.calls.some((call) => call.body.sort === "DESC")
    );
    const result = await context.adapter.send({
      platform: "imessage",
      accountId: "im-imessage-test",
      chat: { kind: "direct", id: "iMessage;-;+15550100" },
      text: "reply",
      mode: "proactive",
      idempotencyKey: "notice-1",
    });
    expect(result).toEqual({ status: "sent", platformMessageId: "sent-1" });
    const call = context.calls.find((entry) =>
      entry.url.includes("/api/v1/message/text")
    );
    expect(call?.body).toMatchObject({
      chatGuid: "iMessage;-;+15550100",
      message: "reply",
      method: "apple-script",
    });
    expect(String(call?.body.tempGuid)).toMatch(/^thebe-[0-9a-f]{32}$/);
    expect(call?.authorization).toBe("blue-secret");
    expect(new URL(call!.url).searchParams.get("password")).toBeNull();
    await context.adapter.stop();
  });

  it("reports an offline bridge and retries instead of discarding", async () => {
    const context = setup({
      response: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });
    await context.adapter.start();
    await waitFor(
      async () => (await context.adapter.health()).state === "error",
      "offline health"
    );
    const result = await context.adapter.send({
      platform: "imessage",
      accountId: "im-imessage-test",
      chat: { kind: "direct", id: "iMessage;-;+15550100" },
      text: "reply",
      mode: "proactive",
      idempotencyKey: "notice-2",
    });
    expect(result).toEqual({
      status: "retry",
      reason: "BlueBubbles is unreachable",
    });
    await context.adapter.stop();
  });

  it("stops polling when BlueBubbles rejects the password", async () => {
    const context = setup({
      response: () => jsonBody({ status: 401, message: "Unauthorized" }, 401),
    });
    await context.adapter.start();
    await waitFor(async () => {
      const health = await context.adapter.health();
      return health.state === "needs_login";
    }, "needs login");
    expect((await context.adapter.health()).code).toBe("invalid_credentials");
    const calls = context.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.calls.length).toBe(calls);
    await context.adapter.stop();
  });
});

describe("iMessage helpers", () => {
  it("validates and normalizes the bridge URL", () => {
    expect(imessageBaseUrl("https://bb.test/base/")).toBe(
      "https://bb.test/base"
    );
    expect(imessageBaseUrl("ftp://bb.test")).toBeUndefined();
    expect(imessageBaseUrl("https://user:password@bb.test")).toBeUndefined();
    expect(
      validateImessageCredentials({
        baseUrl: "https://bb.test",
        password: "secret",
      })
    ).toBeUndefined();
    expect(validateImessageCredentials({ baseUrl: "nope" })).toBe(
      "baseUrl must be an http or https URL"
    );
    expect(validateImessageCredentials({ backend: "carrier-pigeon" })).toBe(
      "backend must be imsg or bluebubbles"
    );
  });

  it("truncates long text and hashes only the bridge URL for a cursor", () => {
    expect(
      truncateImessageText("x".repeat(IMESSAGE_MAX_TEXT + 10))
    ).toHaveLength(IMESSAGE_MAX_TEXT);
    expect(imessageCursorIdentity({ baseUrl: "https://bb.test" })).toBe(
      imessageCursorIdentity({ baseUrl: "https://bb.test/" })
    );
  });
});
