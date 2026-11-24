import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createImGateway } from "../../agent/im/gateway.ts";
import type {
  ImAdapter,
  ImAdapterFactory,
  ImCapabilities,
  ImHealth,
  ImInbound,
  ImLoginAdapter,
  ImRecallInput,
  ImRecallResult,
  ImSendInput,
  ImSendResult,
} from "../../agent/im/types.ts";
import { createThebeHttpHandler } from "./handler.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

class FakeAdapter implements ImAdapter {
  readonly platform = "telegram" as const;
  readonly capabilities: ImCapabilities = {
    proactive: true,
    replyOnly: false,
    recall: false,
    media: false,
    maxTextLength: 4096,
  };
  sent: ImSendInput[] = [];
  recalled: ImRecallInput[] = [];
  private handler: ((message: ImInbound) => Promise<void>) | undefined;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<ImHealth> {
    return { state: "connected" };
  }
  async send(input: ImSendInput): Promise<ImSendResult> {
    this.sent.push(input);
    return { status: "sent", platformMessageId: "m1" };
  }
  async recall(input: ImRecallInput): Promise<ImRecallResult> {
    this.recalled.push(input);
    return { status: "recalled" };
  }
  onInbound(handler: (message: ImInbound) => Promise<void>): void {
    this.handler = handler;
  }
  emit(message: ImInbound): Promise<void> {
    return this.handler ? this.handler(message) : Promise.resolve();
  }
}

async function setup(
  options: {
    login?: ImLoginAdapter;
    credentials?: ImAdapterFactory["credentials"];
  } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), "thebe-im-http-"));
  dirs.push(dir);
  const adapters = new Map<string, FakeAdapter>();
  const factory: ImAdapterFactory = {
    platform: "telegram",
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.login ? { createLogin: () => options.login! } : {}),
    create: (input) => {
      const adapter = new FakeAdapter();
      adapters.set(input.account.id, adapter);
      return adapter;
    },
  };
  const prompts: string[] = [];
  const gateway = createImGateway({
    dir,
    factories: [factory],
    agent: {
      async askMainSession(text: string) {
        prompts.push(text);
        return { text: `reply: ${text}` };
      },
    },
  });
  await gateway.start();
  const handler = createThebeHttpHandler({
    version: "test",
    token: "secret",
    im: gateway,
  });
  async function call(path: string, init: RequestInit = {}) {
    const response = await handler.handle(
      new Request(`http://127.0.0.1:8787${path}`, {
        ...init,
        headers: {
          "X-Thebe-Token": "secret",
          "content-type": "application/json",
          ...init.headers,
        },
      })
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }
  return { gateway, handler, adapters, prompts, call };
}

describe("IM HTTP routes", () => {
  it("adds a channel, binds an owner chat, and sends a test message", async () => {
    const { gateway, adapters, call } = await setup();
    const created = await call("/v1/im/channels", {
      method: "POST",
      body: JSON.stringify({
        platform: "telegram",
        label: "Phone",
        token: "test-token",
      }),
    });
    expect(created.status).toBe(201);
    const channel = created.body.channel as { id: string; platform: string };
    expect(channel.platform).toBe("telegram");
    expect(JSON.stringify(created.body)).not.toContain("test-token");

    const listed = await call("/v1/im/channels");
    expect(listed.body.channels).toEqual([
      expect.objectContaining({ id: channel.id, bindings: 0 }),
    ]);
    await adapters.get(channel.id)!.emit({
      platform: "telegram",
      accountId: channel.id,
      chat: { kind: "direct", id: "42", title: "@owner" },
      sender: { id: "42" },
      messageId: "4",
      updateId: "99",
      text: "observe",
      receivedAt: "2026-11-15T10:00:00.000Z",
    });

    const bound = await call("/v1/im/bind", {
      method: "POST",
      body: JSON.stringify({
        accountId: channel.id,
        chat: { kind: "direct", id: "42", title: "@owner" },
        role: "owner",
      }),
    });
    expect(bound.status).toBe(201);
    expect(bound.body.binding).toMatchObject({
      accountId: channel.id,
      role: "owner",
      sessionId: "thebe-main",
      senderId: "42",
    });

    const test = await call(`/v1/im/channels/${channel.id}/test`, {
      method: "POST",
    });
    expect(test.status).toBe(200);
    expect(test.body).toMatchObject({ ok: true, status: "sent" });

    const status = await call("/v1/im/status");
    expect(status.body).toMatchObject({
      ok: true,
      pending: 0,
      channels: [
        {
          id: channel.id,
          health: { state: "connected" },
          bindings: 1,
        },
      ],
    });
    await gateway.stop();
  });

  it("recalls an eligible message through the configured IM adapter", async () => {
    const { gateway, adapters, call } = await setup();
    const created = await call("/v1/im/channels", {
      method: "POST",
      body: JSON.stringify({
        platform: "telegram",
        label: "Phone",
        token: "test-token",
      }),
    });
    const channel = created.body.channel as { id: string };
    const adapter = adapters.get(channel.id)!;
    adapter.capabilities.recall = true;

    const recalled = await call("/v1/im/recall", {
      method: "POST",
      body: JSON.stringify({
        accountId: channel.id,
        chat: { kind: "direct", id: "42" },
        messageId: "m1",
      }),
    });

    expect(recalled.status).toBe(200);
    expect(recalled.body).toEqual({
      ok: true,
      status: "recalled",
    });
    expect(adapter.recalled).toHaveLength(1);
    await gateway.stop();
  });

  it("accepts bounded base64 media without exposing a caller filesystem path", async () => {
    const { gateway, adapters, call } = await setup();
    const created = await call("/v1/im/channels", {
      method: "POST",
      body: JSON.stringify({
        platform: "telegram",
        label: "Phone",
        token: "test-token",
      }),
    });
    const channel = created.body.channel as { id: string };
    const adapter = adapters.get(channel.id)!;
    adapter.capabilities.media = true;
    const sent = await call("/v1/im/send", {
      method: "POST",
      body: JSON.stringify({
        accountId: channel.id,
        chat: { kind: "direct", id: "42" },
        text: "",
        media: [
          {
            kind: "image",
            mediaType: "image/png",
            data: "iVBORw0KGgo=",
            filename: "chart.png",
          },
        ],
      }),
    });

    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, status: "sent" });
    expect(adapter.sent[0]).toMatchObject({
      text: "",
      media: [
        {
          kind: "image",
          mediaType: "image/png",
          filename: "chart.png",
        },
      ],
    });
    expect(JSON.stringify(adapter.sent[0])).not.toContain("/tmp/");
    await gateway.stop();
  });

  it("routes an owner message through the gateway and lists the conversation", async () => {
    const { gateway, adapters, prompts, call } = await setup();
    const created = await call("/v1/im/channels", {
      method: "POST",
      body: JSON.stringify({ platform: "telegram", token: "test-token" }),
    });
    const channel = created.body.channel as { id: string };
    const adapter = adapters.get(channel.id)!;
    await adapter.emit({
      platform: "telegram",
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      sender: { id: "42" },
      messageId: "4",
      updateId: "99",
      text: "observe",
      receivedAt: "2026-11-15T10:00:00.000Z",
    });
    await call("/v1/im/bind", {
      method: "POST",
      body: JSON.stringify({
        accountId: channel.id,
        chat: { kind: "direct", id: "42" },
      }),
    });
    await adapter.emit({
      platform: "telegram",
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      sender: { id: "42" },
      messageId: "5",
      updateId: "100",
      text: "status?",
      replyTo: "5",
      receivedAt: "2026-11-15T10:00:00.000Z",
    });
    for (
      let attempt = 0;
      attempt < 100 && adapter.sent.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(prompts).toEqual(["status?"]);
    expect(adapter.sent[0]).toMatchObject({
      text: "reply: status?",
      mode: "reply",
      replyTo: "5",
    });
    const conversations = await call("/v1/im/conversations");
    expect(conversations.body.conversations).toEqual([
      expect.objectContaining({
        accountId: channel.id,
        chat: { kind: "direct", id: "42" },
      }),
    ]);
    await gateway.stop();
  });

  it("rejects an invalid platform, a group owner binding, and an unknown channel", async () => {
    const { gateway, call } = await setup();
    const invalid = await call("/v1/im/channels", {
      method: "POST",
      body: JSON.stringify({ platform: "carrier-pigeon", token: "test-token" }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("unsupported_platform");

    const created = await call("/v1/im/channels", {
      method: "POST",
      body: JSON.stringify({ platform: "telegram", token: "test-token" }),
    });
    const channel = created.body.channel as { id: string };
    const group = await call("/v1/im/bind", {
      method: "POST",
      body: JSON.stringify({
        accountId: channel.id,
        chat: { kind: "group", id: "-100" },
        role: "owner",
      }),
    });
    expect(group.status).toBe(400);
    expect(group.body.code).toBe("group_owner_not_supported");

    const missing = await call("/v1/im/channels/im-missing/test", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
    await gateway.stop();
  });

  it("lists registered platforms and their credential fields", async () => {
    const login: ImLoginAdapter = {
      async begin() {
        throw new Error("not used");
      },
      async poll() {
        return { state: "pending" };
      },
      async cancel() {},
    };
    const { gateway, call } = await setup({
      credentials: [{ key: "token", label: "Bot token", secret: true }],
      login,
    });
    const listed = await call("/v1/im/platforms");
    expect(listed.status).toBe(200);
    expect(listed.body.platforms).toEqual([
      {
        platform: "telegram",
        credentials: [{ key: "token", label: "Bot token", secret: true }],
        login: true,
      },
    ]);
    await gateway.stop();
  });

  it("accepts a platform credential object without echoing it", async () => {
    const { gateway, call } = await setup();
    const created = await call("/v1/im/channels", {
      method: "POST",
      body: JSON.stringify({
        platform: "telegram",
        label: "Credential object",
        credentials: { token: "test-token" },
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.channel).toMatchObject({
      platform: "telegram",
      label: "Credential object",
    });
    expect(JSON.stringify(created.body)).not.toContain("test-token");
    const status = await call("/v1/im/status");
    expect(JSON.stringify(status.body)).not.toContain("test-token");
    await gateway.stop();
  });

  it("runs a login and never returns the resulting credentials", async () => {
    let token = "";
    const login: ImLoginAdapter = {
      async begin() {
        token = "123456789:AAHfakefakefakefakefakefakefakefake";
        return {
          id: "challenge-route",
          platform: "telegram",
          kind: "qr",
          content: "qr-payload",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async poll() {
        return { state: "confirmed", credentials: { token } };
      },
      async cancel() {},
    };
    const { gateway, call } = await setup({ login });
    const started = await call("/v1/im/logins", {
      method: "POST",
      body: JSON.stringify({ platform: "telegram", label: "Phone" }),
    });
    expect(started.status).toBe(201);
    const view = started.body.login as { id: string; content?: string };
    expect(view.content).toBe("qr-payload");
    const confirmed = await call(`/v1/im/logins/${view.id}`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.login).toMatchObject({ state: "confirmed" });
    expect(
      (confirmed.body.login as { content?: string }).content
    ).toBeUndefined();
    expect(
      (confirmed.body.login as { accountId?: string }).accountId
    ).toBeTruthy();
    expect(JSON.stringify(confirmed.body)).not.toContain(token);
    const channels = await call("/v1/im/channels");
    expect(channels.body.channels).toEqual([
      expect.objectContaining({ label: "Phone" }),
    ]);
    expect((await call(`/v1/im/logins/${view.id}`)).status).toBe(404);
    await gateway.stop();
  });

  it("keeps a PIN challenge alive and submits the code", async () => {
    let submitted = "";
    let verified = false;
    const login: ImLoginAdapter = {
      async begin() {
        return {
          id: "wechat-qr",
          platform: "telegram",
          kind: "qr",
          content: "weixin://qr",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async poll() {
        if (!verified)
          return { state: "need_verifycode", detail: "PIN required" };
        return { state: "confirmed", credentials: { token: "wx-token" } };
      },
      async cancel() {},
      async submitCode(_id, code) {
        submitted = code;
        verified = true;
      },
    };
    const { gateway, call } = await setup({ login });
    const started = await call("/v1/im/logins", {
      method: "POST",
      body: JSON.stringify({ platform: "telegram", label: "Phone" }),
    });
    expect(started.status).toBe(201);
    const id = (started.body.login as { id: string }).id;

    const pin = await call(`/v1/im/logins/${id}`);
    expect(pin.body.login).toMatchObject({ state: "need_verifycode" });

    const submittedResponse = await call(`/v1/im/logins/${id}/code`, {
      method: "POST",
      body: JSON.stringify({ code: "1234" }),
    });
    expect(submittedResponse.status).toBe(200);
    expect(submittedResponse.body.login).toMatchObject({
      state: "pending",
      detail: "verification code submitted",
    });
    expect(submitted).toBe("1234");

    const confirmed = await call(`/v1/im/logins/${id}`);
    expect(confirmed.body.login).toMatchObject({ state: "confirmed" });
    expect(JSON.stringify(confirmed.body)).not.toContain("wx-token");
    await gateway.stop();
  });

  it("cancels an in-progress login", async () => {
    let cancelled = "";
    const login: ImLoginAdapter = {
      async begin() {
        return {
          id: "challenge-cancel",
          platform: "telegram",
          kind: "link",
          content: "https://login.test",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async poll() {
        return { state: "pending" };
      },
      async cancel(challengeId) {
        cancelled = challengeId;
      },
    };
    const { gateway, call } = await setup({ login });
    const started = await call("/v1/im/logins", {
      method: "POST",
      body: JSON.stringify({ platform: "telegram" }),
    });
    const id = (started.body.login as { id: string }).id;
    const cancelledResponse = await call(`/v1/im/logins/${id}`, {
      method: "DELETE",
    });
    expect(cancelledResponse.status).toBe(200);
    expect(cancelled).toBe("challenge-cancel");
    expect((await call(`/v1/im/logins/${id}`)).status).toBe(404);
    await gateway.stop();
  });

  it("reports IM in health only when a channel is configured", async () => {
    const { gateway, call } = await setup();
    const before = await call("/v1/health");
    expect(before.body.capabilities).not.toContain("im");
    await call("/v1/im/channels", {
      method: "POST",
      body: JSON.stringify({ platform: "telegram", token: "test-token" }),
    });
    const after = await call("/v1/health");
    expect(after.body.capabilities).toContain("im");
    expect(after.body.im).toMatchObject({ pending: 0 });
    await gateway.stop();
  });
});
