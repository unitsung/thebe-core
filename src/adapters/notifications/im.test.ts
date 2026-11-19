import { describe, expect, it } from "vitest";
import { createImNotificationAdapter } from "./im.ts";
import type { ImGateway } from "../../agent/im/gateway.ts";
import type {
  ImCapabilities,
  ImReplyAnchor,
  ImSendInput,
} from "../../agent/im/types.ts";
import type { NotificationTarget } from "../../agent/notifications/types.ts";

function channel(address: Record<string, string>) {
  return { source: "im", thread: "im:test", address };
}

function target(address: Record<string, string>): NotificationTarget {
  return {
    id: "target-im",
    channel: channel(address),
    categories: "all",
    enabled: true,
  };
}

function gateway(options: {
  capabilities?: ImCapabilities;
  result?: Awaited<ReturnType<ImGateway["send"]>>;
  anchor?: ImReplyAnchor;
  replyWindowMs?: number;
  startError?: Error;
}) {
  const sent: ImSendInput[] = [];
  const im = {
    start: async () => {
      if (options.startError) throw options.startError;
    },
    capabilitiesFor: () => options.capabilities ?? proactiveCapabilities,
    replyWindowMsFor: () => options.replyWindowMs,
    replyAnchor: () => options.anchor,
    send: async (input: ImSendInput) => {
      sent.push(input);
      return options.result ?? { status: "sent" as const };
    },
  } as unknown as ImGateway;
  return { im, sent };
}

const proactiveCapabilities: ImCapabilities = {
  proactive: true,
  replyOnly: false,
  recall: false,
  media: false,
  maxTextLength: 10_000,
};

describe("IM notification adapter", () => {
  it("accepts only a complete im address", () => {
    const adapter = createImNotificationAdapter({ im: gateway({}).im });
    expect(
      adapter.accepts(
        channel({ accountId: "a", chatKind: "direct", chatId: "c" })
      )
    ).toBe(true);
    expect(
      adapter.accepts(
        channel({ accountId: "a", chatKind: "group", chatId: "c" })
      )
    ).toBe(true);
    expect(adapter.accepts(channel({ accountId: "a", chatId: "c" }))).toBe(
      false
    );
    expect(
      adapter.accepts(
        channel({ accountId: "a", chatKind: "thread", chatId: "c" })
      )
    ).toBe(false);
    expect(adapter.accepts({ source: "telegram", thread: "x" })).toBe(false);
  });

  it("sends a proactive notice with the stable idempotency key", async () => {
    const { im, sent } = gateway({});
    const adapter = createImNotificationAdapter({ im });
    const result = await adapter.send({
      target: target({
        accountId: "imessage-env",
        chatKind: "direct",
        chatId: "iMessage;-;+15550100",
      }),
      notification: {
        id: "notice-1",
        category: "attention",
        priority: "normal",
        title: "Thebe",
        body: "A ticket needs you.",
        deepLink: "thebe://ticket/1",
        createdAt: "2026-11-18T10:00:00Z",
      },
      idempotencyKey: "notice-1:target-im",
    });
    expect(result).toEqual({ status: "sent" });
    expect(sent[0]).toMatchObject({
      accountId: "imessage-env",
      chat: { kind: "direct", id: "iMessage;-;+15550100" },
      mode: "proactive",
      idempotencyKey: "notice-1:target-im",
    });
    expect(sent[0]?.text).toContain("Thebe");
    expect(sent[0]?.text).toContain("thebe://ticket/1");
  });

  it("retries when the IM gateway cannot start", async () => {
    const { im, sent } = gateway({
      startError: new Error("store unavailable"),
    });
    const adapter = createImNotificationAdapter({ im });
    const result = await adapter.send({
      target: target({ accountId: "a", chatKind: "direct", chatId: "c" }),
      notification: {
        id: "notice-start",
        category: "attention",
        priority: "normal",
        title: "Thebe",
        body: "hello",
        createdAt: "2026-11-18T10:00:00Z",
      },
      idempotencyKey: "notice-start",
    });
    expect(result).toEqual({ status: "retry", reason: "im_unavailable" });
    expect(sent).toHaveLength(0);
  });

  it("does not queue a notice for a reply-only channel without an inbound anchor", async () => {
    const { im, sent } = gateway({
      capabilities: {
        ...proactiveCapabilities,
        proactive: false,
        replyOnly: true,
      },
    });
    const adapter = createImNotificationAdapter({ im });
    const result = await adapter.send({
      target: target({ accountId: "qq-env", chatKind: "direct", chatId: "u1" }),
      notification: {
        id: "notice-2",
        category: "attention",
        priority: "normal",
        title: "Thebe",
        body: "hello",
        createdAt: "2026-11-18T10:00:00Z",
      },
      idempotencyKey: "notice-2",
    });
    expect(result).toEqual({ status: "discard", reason: "window_closed" });
    expect(sent).toHaveLength(0);
  });

  it("uses the latest inbound anchor for a reply-only channel inside its window", async () => {
    const { im, sent } = gateway({
      capabilities: {
        ...proactiveCapabilities,
        proactive: false,
        replyOnly: true,
        replyWindowMs: 60 * 60_000,
      },
      anchor: {
        replyTo: "qq-msg-1",
        receivedAt: "2026-11-18T09:59:00Z",
      },
    });
    const adapter = createImNotificationAdapter({
      im,
      now: () => new Date("2026-11-18T10:00:00Z"),
    });
    const result = await adapter.send({
      target: target({ accountId: "qq-env", chatKind: "direct", chatId: "u1" }),
      notification: {
        id: "notice-2b",
        category: "attention",
        priority: "normal",
        title: "Thebe",
        body: "hello",
        createdAt: "2026-11-18T10:00:00Z",
      },
      idempotencyKey: "notice-2b",
    });
    expect(result).toEqual({ status: "sent" });
    expect(sent[0]).toMatchObject({
      mode: "reply",
      replyTo: "qq-msg-1",
    });
    expect(sent[0]?.contextToken).toBeUndefined();
  });

  it("drops a reply-only notice when the inbound window has closed", async () => {
    const { im, sent } = gateway({
      capabilities: {
        ...proactiveCapabilities,
        proactive: false,
        replyOnly: true,
        replyWindowMs: 5 * 60_000,
      },
      anchor: {
        replyTo: "qq-msg-1",
        receivedAt: "2026-11-18T09:50:00Z",
      },
    });
    const adapter = createImNotificationAdapter({
      im,
      now: () => new Date("2026-11-18T10:00:00Z"),
    });
    const result = await adapter.send({
      target: target({ accountId: "qq-env", chatKind: "direct", chatId: "u1" }),
      notification: {
        id: "notice-2c",
        category: "attention",
        priority: "normal",
        title: "Thebe",
        body: "hello",
        createdAt: "2026-11-18T10:00:00Z",
      },
      idempotencyKey: "notice-2c",
    });
    expect(result).toEqual({ status: "discard", reason: "window_closed" });
    expect(sent).toHaveLength(0);
  });

  it("uses the adapter's per-chat window before discarding a reply", async () => {
    const { im, sent } = gateway({
      capabilities: {
        ...proactiveCapabilities,
        proactive: false,
        replyOnly: true,
        replyWindowMs: 5 * 60_000,
      },
      replyWindowMs: 60 * 60_000,
      anchor: {
        replyTo: "qq-msg-1",
        receivedAt: "2026-11-18T09:50:00Z",
      },
    });
    const adapter = createImNotificationAdapter({
      im,
      now: () => new Date("2026-11-18T10:00:00Z"),
    });
    const result = await adapter.send({
      target: target({ accountId: "qq-env", chatKind: "direct", chatId: "u1" }),
      notification: {
        id: "notice-2e",
        category: "attention",
        priority: "normal",
        title: "Thebe",
        body: "hello",
        createdAt: "2026-11-18T10:00:00Z",
      },
      idempotencyKey: "notice-2e",
    });
    expect(result).toEqual({ status: "sent" });
    expect(sent[0]).toMatchObject({
      mode: "reply",
      replyTo: "qq-msg-1",
    });
  });

  it("passes a Weixin context token when the anchor carries one", async () => {
    const { im, sent } = gateway({
      capabilities: {
        ...proactiveCapabilities,
        proactive: false,
        replyOnly: true,
      },
      anchor: {
        replyTo: "wechat-msg-1",
        contextToken: "ctx-1",
        receivedAt: "2026-11-18T09:59:30Z",
      },
    });
    const adapter = createImNotificationAdapter({
      im,
      now: () => new Date("2026-11-18T10:00:00Z"),
    });
    const result = await adapter.send({
      target: target({
        accountId: "wechat-env",
        chatKind: "direct",
        chatId: "u1",
      }),
      notification: {
        id: "notice-2d",
        category: "attention",
        priority: "normal",
        title: "Thebe",
        body: "hello",
        createdAt: "2026-11-18T10:00:00Z",
      },
      idempotencyKey: "notice-2d",
    });
    expect(result).toEqual({ status: "sent" });
    expect(sent[0]).toMatchObject({
      mode: "reply",
      replyTo: "wechat-msg-1",
      contextToken: "ctx-1",
    });
  });

  it("maps the gateway result and truncates without losing the deep link", async () => {
    const { im, sent } = gateway({
      capabilities: { ...proactiveCapabilities, maxTextLength: 60 },
      result: { status: "retry", reason: "busy", retryAfterMs: 500 },
    });
    const adapter = createImNotificationAdapter({ im });
    const result = await adapter.send({
      target: target({ accountId: "a", chatKind: "direct", chatId: "c" }),
      notification: {
        id: "notice-3",
        category: "attention",
        priority: "normal",
        title: "A very long title that will be truncated",
        body: "A very long body that will also be truncated by the adapter.",
        deepLink: "thebe://ticket/123",
        createdAt: "2026-11-18T10:00:00Z",
      },
      idempotencyKey: "notice-3",
    });
    expect(result).toEqual({
      status: "retry",
      reason: "busy",
      retryAfterMs: 500,
    });
    expect(sent[0]?.text.length).toBeLessThanOrEqual(60);
    expect(sent[0]?.text).toContain("thebe://ticket/123");
    expect(sent[0]?.text).toContain("…");
  });
});
