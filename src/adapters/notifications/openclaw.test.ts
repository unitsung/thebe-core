import { describe, expect, it } from "vitest";
import type { NotificationSendInput } from "../../agent/notifications/types.ts";
import {
  createOpenClawNotificationAdapter,
  type OpenClawRunResult,
} from "./openclaw.ts";

function input(address: Record<string, string>): NotificationSendInput {
  return {
    target: {
      id: "ops",
      channel: { source: "openclaw", thread: "ops", address },
      categories: "all",
      enabled: true,
    },
    notification: {
      id: "event-1",
      category: "attention",
      priority: "critical",
      title: "Thebe",
      body: "Something needs you.",
      deepLink: "thebe://goal/42",
      createdAt: "2026-11-14T10:00:00.000Z",
    },
    idempotencyKey: "idem-1",
  };
}

function result(overrides: Partial<OpenClawRunResult> = {}): OpenClawRunResult {
  return {
    code: 0,
    stdout: '{"ok":true}',
    stderr: "",
    ...overrides,
  };
}

describe("OpenClaw notification bridge", () => {
  it("uses the CLI send surface and passes channel target options", async () => {
    let args: readonly string[] = [];
    const adapter = createOpenClawNotificationAdapter({
      bin: "/opt/openclaw",
      run: async (value) => {
        args = value;
        return result({ stdout: '{"deliveryStatus":{"status":"sent"}}' });
      },
    });
    const address = {
      channel: "telegram",
      target: "12345",
      account: "work",
      threadId: "7",
      replyTo: "99",
      silent: "true",
    };
    expect(adapter.accepts({ source: "openclaw", thread: "t", address })).toBe(
      true
    );
    expect(await adapter.send(input(address))).toEqual({ status: "sent" });
    expect(args).toEqual([
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      "12345",
      "--message",
      "Thebe\n\nSomething needs you.\n\nthebe://goal/42",
      "--json",
      "--account",
      "work",
      "--thread-id",
      "7",
      "--reply-to",
      "99",
      "--silent",
    ]);
  });

  it("maps a rejected target to discard and a rate limit to retry", async () => {
    const rejected = createOpenClawNotificationAdapter({
      run: async () =>
        result({
          code: 1,
          stdout: '{"ok":false,"reason":"invalid_delivery_target"}',
        }),
    });
    expect(
      await rejected.send(input({ channel: "slack", target: "nope" }))
    ).toMatchObject({
      status: "discard",
      reason: expect.stringContaining("invalid_delivery_target"),
    });

    const busy = createOpenClawNotificationAdapter({
      run: async () =>
        result({ code: 1, stderr: "Too many requests, try again" }),
    });
    expect(
      await busy.send(input({ channel: "discord", target: "channel:1" }))
    ).toMatchObject({ status: "retry", retryAfterMs: 60_000 });
  });

  it("marks a timeout as unknown and a missing CLI as discard", async () => {
    const timedOut = createOpenClawNotificationAdapter({
      run: async () => result({ code: 1, timedOut: true }),
    });
    expect(
      await timedOut.send(input({ channel: "telegram", target: "1" }))
    ).toMatchObject({ status: "unknown" });

    const missing = createOpenClawNotificationAdapter({
      run: async () => result({ code: 1, spawnError: "ENOENT" }),
    });
    expect(
      await missing.send(input({ channel: "telegram", target: "1" }))
    ).toMatchObject({
      status: "discard",
      reason: expect.stringContaining("ENOENT"),
    });
  });

  it("rejects an address without a channel or target", () => {
    const adapter = createOpenClawNotificationAdapter({});
    expect(
      adapter.accepts({
        source: "openclaw",
        thread: "t",
        address: { target: "1" },
      })
    ).toBe(false);
    expect(
      adapter.accepts({
        source: "openclaw",
        thread: "t",
        address: { channel: "BAD CHANNEL", target: "1" },
      })
    ).toBe(false);
  });
});

function gatewayResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rawGatewayResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

describe("OpenClaw gateway bridge", () => {
  it("invokes the message tool over HTTP with auth and routing args", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const adapter = createOpenClawNotificationAdapter({
      gateway: {
        url: "http://openclaw:18789",
        token: "secret",
        sessionKey: "agent:ops:main",
      },
      run: async () => {
        throw new Error("the CLI must not be used when a gateway is set");
      },
      fetch: async (input, request) => {
        url = String(input);
        init = request;
        return gatewayResponse({
          ok: true,
          result: {
            details: {
              messageDelivery: {
                status: "settled",
                partialDelivery: false,
                createdThreadIds: [],
              },
            },
          },
        });
      },
    });
    const address = {
      channel: "telegram",
      target: "12345",
      account: "work",
      threadId: "7",
      replyTo: "99",
      silent: "true",
    };
    expect(await adapter.send(input(address))).toEqual({ status: "sent" });
    expect(url).toBe("http://openclaw:18789/tools/invoke");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(JSON.parse(String(init?.body))).toEqual({
      tool: "message",
      action: "send",
      args: {
        channel: "telegram",
        target: "12345",
        message: "Thebe\n\nSomething needs you.\n\nthebe://goal/42",
        accountId: "work",
        threadId: "7",
        replyTo: "99",
        silent: true,
      },
      sessionKey: "agent:ops:main",
      idempotencyKey: "idem-1",
    });
  });

  it("accepts a full tools/invoke URL and maps delivery facts", async () => {
    let calls = 0;
    const adapter = createOpenClawNotificationAdapter({
      gateway: { url: "http://openclaw:18789/tools/invoke/" },
      fetch: async () => {
        calls += 1;
        return gatewayResponse({
          ok: true,
          result: {
            details: {
              messageDelivery: {
                status: calls === 1 ? "suppressed" : "settled",
                partialDelivery: calls === 1 ? false : true,
                createdThreadIds: [],
              },
            },
          },
        });
      },
    });
    expect(
      await adapter.send(input({ channel: "slack", target: "C1" }))
    ).toEqual({ status: "discard", reason: "openclaw_suppressed" });
    expect(
      await adapter.send(input({ channel: "slack", target: "C1" }))
    ).toEqual({ status: "unknown", reason: "openclaw partial delivery" });
  });

  it("maps HTTP failures to retry or discard", async () => {
    const busy = createOpenClawNotificationAdapter({
      gateway: { url: "http://openclaw:18789" },
      fetch: async () =>
        gatewayResponse({ ok: false, error: { message: "slow down" } }, 429, {
          "retry-after": "2",
        }),
    });
    expect(
      await busy.send(input({ channel: "slack", target: "C1" }))
    ).toMatchObject({ status: "retry", retryAfterMs: 2_000 });

    const denied = createOpenClawNotificationAdapter({
      gateway: { url: "http://openclaw:18789" },
      fetch: async () =>
        gatewayResponse(
          { ok: false, error: { message: "tool not available" } },
          404
        ),
    });
    expect(
      await denied.send(input({ channel: "slack", target: "C1" }))
    ).toMatchObject({
      status: "discard",
      reason: expect.stringContaining("tool not available"),
    });
  });

  it("treats a gateway timeout as unknown and an invalid URL as discard", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const timedOut = createOpenClawNotificationAdapter({
      gateway: { url: "http://openclaw:18789" },
      fetch: async () => {
        throw timeout;
      },
    });
    expect(
      await timedOut.send(input({ channel: "telegram", target: "1" }))
    ).toMatchObject({ status: "unknown" });

    const invalid = createOpenClawNotificationAdapter({
      gateway: { url: "file:///tmp/openclaw.sock" },
    });
    expect(
      await invalid.send(input({ channel: "telegram", target: "1" }))
    ).toEqual({ status: "discard", reason: "openclaw_gateway_url_invalid" });
  });

  // A 200 means the tool ran, but the send itself can still have failed. These
  // must never be recorded as "sent", which would silently drop the notice.
  it.each([
    {
      name: "nested ok:false with error object",
      body: { ok: true, result: { ok: false, error: { message: "no route" } } },
    },
    {
      name: "nested failure status",
      body: { ok: true, result: { status: "failed" } },
    },
    {
      name: "failure in details",
      body: { ok: true, result: { details: { error: "channel offline" } } },
    },
  ])("retries a 2xx that hides a failed delivery ($name)", async ({ body }) => {
    const adapter = createOpenClawNotificationAdapter({
      gateway: { url: "http://openclaw:18789" },
      fetch: async () => gatewayResponse(body),
    });
    expect(
      await adapter.send(input({ channel: "slack", target: "C1" }))
    ).toMatchObject({ status: "retry" });
  });

  it("records a 2xx without a delivery receipt as unknown, never sent", async () => {
    const empty = createOpenClawNotificationAdapter({
      gateway: { url: "http://openclaw:18789" },
      fetch: async () => gatewayResponse({ ok: true, result: {} }),
    });
    expect(await empty.send(input({ channel: "slack", target: "C1" }))).toEqual(
      { status: "unknown", reason: "openclaw delivery unconfirmed" }
    );

    const nonJson = createOpenClawNotificationAdapter({
      gateway: { url: "http://openclaw:18789" },
      fetch: async () => rawGatewayResponse("gateway is starting"),
    });
    expect(
      await nonJson.send(input({ channel: "slack", target: "C1" }))
    ).toEqual({ status: "unknown", reason: "openclaw delivery unconfirmed" });
  });

  it("maps a failed delivery fact to retry and dryRun to discard", async () => {
    const failed = createOpenClawNotificationAdapter({
      gateway: { url: "http://openclaw:18789" },
      fetch: async () =>
        gatewayResponse({
          ok: true,
          result: {
            details: {
              messageDelivery: {
                status: "failed",
                partialDelivery: false,
                createdThreadIds: [],
              },
            },
          },
        }),
    });
    expect(
      await failed.send(input({ channel: "slack", target: "C1" }))
    ).toEqual({ status: "retry", reason: "openclaw delivery failed" });

    const dryRun = createOpenClawNotificationAdapter({
      gateway: { url: "http://openclaw:18789" },
      fetch: async () =>
        gatewayResponse({
          ok: true,
          result: {
            details: {
              messageDelivery: {
                status: "dryRun",
                partialDelivery: false,
                createdThreadIds: [],
              },
            },
          },
        }),
    });
    expect(
      await dryRun.send(input({ channel: "slack", target: "C1" }))
    ).toEqual({ status: "discard", reason: "openclaw_dry_run" });
  });

  it("retries busy and server statuses", async () => {
    for (const code of [408, 425, 500, 503]) {
      const adapter = createOpenClawNotificationAdapter({
        gateway: { url: "http://openclaw:18789" },
        fetch: async () =>
          gatewayResponse({ ok: false, error: { message: "busy" } }, code),
      });
      expect(
        await adapter.send(input({ channel: "slack", target: "C1" })),
        `status ${code}`
      ).toMatchObject({ status: "retry" });
    }
  });
});
