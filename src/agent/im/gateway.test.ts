import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createImGateway,
  type ImGateway,
  type ImGatewayAgent,
} from "./gateway.ts";
import type {
  ImAdapter,
  ImAdapterFactory,
  ImCapabilities,
  ImChat,
  ImHealth,
  ImInbound,
  ImLoginAdapter,
  ImMediaFetchInput,
  ImMediaFetchResult,
  ImRecallInput,
  ImRecallResult,
  ImSendInput,
  ImSendResult,
  ImSender,
} from "./types.ts";

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
  mediaFetches: ImMediaFetchInput[] = [];
  started = false;
  stopped = false;
  healthValue: ImHealth = { state: "connected" };
  createdWithCursor?: string;
  reportCursor: (cursor: string) => void = () => {};
  canSendProactively?: (chat: ImChat) => boolean | Promise<boolean>;
  replyWindowMsFor?: (chat: ImChat) => number | undefined;
  private handler: ((message: ImInbound) => Promise<void>) | undefined;

  async start(): Promise<void> {
    this.started = true;
    this.healthValue = { state: "connected" };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.healthValue = { state: "stopped" };
  }

  async health(): Promise<ImHealth> {
    return this.healthValue;
  }

  async send(input: ImSendInput): Promise<ImSendResult> {
    this.sent.push(input);
    return { status: "sent", platformMessageId: `m${this.sent.length}` };
  }

  async recall(input: ImRecallInput): Promise<ImRecallResult> {
    this.recalled.push(input);
    return { status: "recalled" };
  }

  async fetchMedia(input: ImMediaFetchInput): Promise<ImMediaFetchResult> {
    this.mediaFetches.push(input);
    return {
      data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mediaType: "image/png",
      filename: "photo.png",
    };
  }

  onInbound(handler: (message: ImInbound) => Promise<void>): void {
    this.handler = handler;
  }

  emit(message: ImInbound): Promise<void> {
    return this.handler ? this.handler(message) : Promise.resolve();
  }
}

type SetupOptions = {
  busy?: () => boolean;
  streaming?: () => boolean;
  ask?: (
    text: string,
    options?: { mode?: "prompt" | "followUp" }
  ) => Promise<{ text: string }>;
  credentials?: ImAdapterFactory["credentials"];
  validateCredentials?: ImAdapterFactory["validateCredentials"];
  cursorIdentity?: ImAdapterFactory["cursorIdentity"];
  login?: ImLoginAdapter;
};

function setup(options: SetupOptions = {}) {
  const adapters = new Map<string, FakeAdapter>();
  const factory: ImAdapterFactory = {
    platform: "telegram",
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.validateCredentials
      ? { validateCredentials: options.validateCredentials }
      : {}),
    ...(options.cursorIdentity
      ? { cursorIdentity: options.cursorIdentity }
      : {}),
    ...(options.login ? { createLogin: () => options.login! } : {}),
    create: (input) => {
      const adapter = new FakeAdapter();
      adapter.createdWithCursor = input.cursor;
      adapter.reportCursor = input.onCursor;
      adapters.set(input.account.id, adapter);
      return adapter;
    },
  };
  const prompts: string[] = [];
  const promptInputs: Array<{ text: string; files?: unknown[] }> = [];
  const agent: ImGatewayAgent = {
    async askMainSession(input, askOptions) {
      const text = typeof input === "string" ? input : input.text;
      promptInputs.push(
        typeof input === "string"
          ? { text: input }
          : { text: input.text, ...(input.files ? { files: input.files } : {}) }
      );
      prompts.push(askOptions?.mode ? `${askOptions.mode}:${text}` : text);
      return options.ask
        ? options.ask(text, askOptions)
        : { text: `echo: ${text}` };
    },
    isMainSessionBusy: () => options.busy?.() ?? false,
    isMainSessionStreaming: () => options.streaming?.() ?? false,
  };
  return { adapters, factory, prompts, promptInputs, agent };
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

function inbound(overrides: Partial<ImInbound> = {}): ImInbound {
  const messageId = overrides.messageId ?? "5";
  return {
    platform: "telegram",
    accountId: overrides.accountId ?? "account",
    chat: { kind: "direct", id: "42", title: "@owner" },
    sender: { id: "42", name: "owner" },
    messageId,
    updateId: overrides.updateId ?? "100",
    text: "/start",
    replyTo: messageId,
    receivedAt: "2026-11-15T10:00:00.000Z",
    ...overrides,
  };
}

async function setupGateway(
  options: SetupOptions & {
    busyConfig?: { retryMs?: number; ttlMs?: number; noticeMs?: number };
  } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), "thebe-im-"));
  dirs.push(dir);
  const fake = setup(options);
  const errors: unknown[] = [];
  const gateway = createImGateway({
    agent: fake.agent,
    dir,
    factories: [fake.factory],
    onError: (error) => errors.push(error),
    ...(options.busyConfig ? { busy: options.busyConfig } : {}),
  });
  const channel = await gateway.addChannel({
    platform: "telegram",
    label: "Test Telegram",
    token: "test-token",
  });
  await gateway.start();
  const adapter = fake.adapters.get(channel.id);
  if (!adapter) throw new Error("adapter was not created");
  return { dir, gateway, channel, adapter, errors, ...fake };
}

/** A binding may now be created only for a chat the adapter has already observed. */
async function observeChat(
  gateway: ImGateway,
  adapter: FakeAdapter,
  accountId: string,
  chat: ImChat = { kind: "direct", id: "42", title: "@owner" },
  sender: ImSender = { id: "42", name: "owner" }
): Promise<void> {
  await adapter.emit(
    inbound({
      accountId,
      chat,
      sender,
      text: "observe",
      messageId: `observe-${chat.id}`,
      updateId: `observe-${chat.id}`,
    })
  );
  const seen = (await gateway.conversations()).some(
    (conversation) =>
      conversation.accountId === accountId &&
      conversation.chat.id === chat.id &&
      conversation.chat.kind === chat.kind
  );
  if (!seen) throw new Error("the test chat was not observed");
}

describe("IM gateway", () => {
  it("creates a channel and reports its adapter health", async () => {
    const { gateway, channel } = await setupGateway();
    const channels = await gateway.channels();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      id: channel.id,
      platform: "telegram",
      health: { state: "connected" },
      source: "settings",
      bindings: 0,
    });
    await gateway.stop();
  });

  it("recalls only through an adapter that truthfully declares support", async () => {
    const { gateway, channel, adapter } = await setupGateway();
    const input = {
      accountId: channel.id,
      chat: { kind: "direct" as const, id: "42" },
      messageId: "m7",
    };

    await expect(gateway.recall(input)).resolves.toEqual({
      status: "discard",
      reason: "recall_not_supported",
    });
    adapter.capabilities.recall = true;
    await expect(gateway.recall(input)).resolves.toEqual({
      status: "recalled",
    });
    expect(adapter.recalled).toEqual([
      {
        platform: "telegram",
        accountId: channel.id,
        chat: { kind: "direct", id: "42" },
        messageId: "m7",
      },
    ]);
    await gateway.stop();
  });

  it("records an unbound direct message, answers /start, and does not call the model", async () => {
    const { gateway, channel, adapter, prompts } = await setupGateway();
    await adapter.emit(inbound({ accountId: channel.id }));
    await waitFor(() => adapter.sent.length === 1, "help reply");
    expect(prompts).toEqual([]);
    expect(adapter.sent[0]).toMatchObject({
      mode: "reply",
      replyTo: "5",
      idempotencyKey: expect.stringContaining("im-reply"),
    });
    expect(adapter.sent[0]!.text).toContain("not paired");
    const conversations = await gateway.conversations();
    expect(conversations).toEqual([
      expect.objectContaining({
        accountId: channel.id,
        chat: { kind: "direct", id: "42", title: "@owner" },
      }),
    ]);
    await gateway.stop();
  });

  it("keeps the latest inbound reply anchor for notification routing", async () => {
    const { gateway, channel, adapter } = await setupGateway();
    expect(
      gateway.replyAnchor(channel.id, { kind: "direct", id: "42" })
    ).toBeUndefined();
    await adapter.emit(
      inbound({
        accountId: channel.id,
        messageId: "9",
        replyTo: "9",
        contextToken: "ctx-9",
        receivedAt: "2026-11-18T10:00:00.000Z",
      })
    );
    expect(
      gateway.replyAnchor(channel.id, { kind: "direct", id: "42" })
    ).toEqual({
      replyTo: "9",
      contextToken: "ctx-9",
      receivedAt: "2026-11-18T10:00:00.000Z",
    });
    expect(
      gateway.replyAnchor("missing", { kind: "direct", id: "42" })
    ).toBeUndefined();
    await gateway.stop();
    expect(
      gateway.replyAnchor(channel.id, { kind: "direct", id: "42" })
    ).toBeUndefined();
  });

  it("tests a reply-only channel with its latest inbound anchor", async () => {
    const { gateway, channel, adapter } = await setupGateway();
    Object.assign(adapter.capabilities, {
      proactive: false,
      replyOnly: true,
      replyWindowMs: 5 * 60_000,
    });
    adapter.replyWindowMsFor = (chat) =>
      chat.kind === "direct" ? 60 * 60_000 : 5 * 60_000;
    await adapter.emit(
      inbound({
        accountId: channel.id,
        messageId: "m1",
        replyTo: "m1",
        contextToken: "ctx-1",
        receivedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      })
    );
    await gateway.bind({
      accountId: channel.id,
      chat: { kind: "direct", id: "42", title: "@owner" },
      role: "owner",
    });
    const result = await gateway.testChannel(channel.id);
    expect(result.status).toBe("sent");
    expect(adapter.sent.at(-1)).toMatchObject({
      mode: "reply",
      replyTo: "m1",
      contextToken: "ctx-1",
    });
    await gateway.stop();
  });

  it("refuses a reply-only test when no inbound anchor exists", async () => {
    const { gateway, channel, adapter, adapters } = await setupGateway();
    Object.assign(adapter.capabilities, {
      proactive: false,
      replyOnly: true,
    });
    await adapter.emit(inbound({ accountId: channel.id }));
    await gateway.bind({
      accountId: channel.id,
      chat: { kind: "direct", id: "42", title: "@owner" },
      role: "owner",
    });
    // A restart clears the in-memory anchor; keep the rebuilt adapter reply-only.
    await gateway.stop();
    await gateway.start();
    const restarted = adapters.get(channel.id);
    if (!restarted) throw new Error("adapter was not recreated");
    Object.assign(restarted.capabilities, {
      proactive: false,
      replyOnly: true,
    });
    await expect(gateway.testChannel(channel.id)).rejects.toMatchObject({
      code: "no_reply_anchor",
    });
    await gateway.stop();
  });

  it("lets an owner binding talk to the main Session and replies in the same chat", async () => {
    const { gateway, channel, adapter, prompts } = await setupGateway();
    await observeChat(gateway, adapter, channel.id);
    const binding = await gateway.bind({
      accountId: channel.id,
      chat: { kind: "direct", id: "42", title: "@owner" },
      role: "owner",
    });
    expect(binding.sessionId).toBe("thebe-main");
    expect(binding.senderId).toBe("42");
    await adapter.emit(
      inbound({
        accountId: channel.id,
        text: "What is running?",
        messageId: "7",
        updateId: "101",
      })
    );
    await waitFor(() => adapter.sent.length === 1, "model reply");
    expect(prompts).toEqual(["What is running?"]);
    expect(adapter.sent[0]).toMatchObject({
      text: "echo: What is running?",
      mode: "reply",
      replyTo: "7",
    });
    await gateway.stop();
  });

  it("requires an observed chat and rejects a direct guest binding", async () => {
    const { gateway, channel, adapter } = await setupGateway();
    await expect(
      gateway.bind({
        accountId: channel.id,
        chat: { kind: "direct", id: "99" },
        role: "owner",
      })
    ).rejects.toMatchObject({ code: "chat_not_seen" });
    await observeChat(gateway, adapter, channel.id);
    await expect(
      gateway.bind({
        accountId: channel.id,
        chat: { kind: "direct", id: "42" },
        role: "guest",
      })
    ).rejects.toMatchObject({ code: "direct_guest_not_supported" });
    await expect(
      gateway.bind({
        accountId: channel.id,
        chat: { kind: "direct", id: "42" },
        role: "owner",
        senderId: "99",
      })
    ).rejects.toMatchObject({ code: "sender_mismatch" });
    await gateway.stop();
  });

  it("pins the owner sender and ignores a different sender in the bound chat", async () => {
    const { gateway, channel, adapter, prompts } = await setupGateway();
    await observeChat(gateway, adapter, channel.id);
    await gateway.bind({
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      role: "owner",
    });
    await adapter.emit(
      inbound({
        accountId: channel.id,
        sender: { id: "99", name: "stranger" },
        text: "let me in",
        messageId: "8",
        updateId: "108",
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts).toEqual([]);
    expect(adapter.sent).toEqual([]);
    await adapter.emit(
      inbound({
        accountId: channel.id,
        sender: { id: "42", name: "owner" },
        text: "hello again",
        messageId: "9",
        updateId: "109",
      })
    );
    await waitFor(() => adapter.sent.length === 1, "owner reply");
    expect(prompts).toEqual(["hello again"]);
    await gateway.stop();
  });

  it("records a media-only message without prompting the model", async () => {
    const { gateway, channel, adapter, prompts, errors } = await setupGateway();
    await adapter.emit(
      inbound({
        accountId: channel.id,
        text: "",
        media: [{ kind: "image", id: "photo-1" }],
        messageId: "16",
        updateId: "116",
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts).toEqual([]);
    expect(adapter.sent).toEqual([]);
    expect(await gateway.conversations()).toEqual([
      expect.objectContaining({
        accountId: channel.id,
        chat: { kind: "direct", id: "42", title: "@owner" },
      }),
    ]);
    await gateway.bind({
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      role: "owner",
    });
    await adapter.emit(
      inbound({
        accountId: channel.id,
        text: "",
        media: [{ kind: "image", id: "photo-2" }],
        messageId: "17",
        updateId: "117",
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (errors.length) throw errors[0];
    await waitFor(() => adapter.sent.length === 1, "media notice");
    expect(prompts).toEqual([]);
    expect(adapter.sent[0]!.text).toContain("cannot read");
    await gateway.stop();
  });

  it("turns an owner image into a bounded model attachment", async () => {
    const { gateway, channel, adapter, prompts, promptInputs, errors } =
      await setupGateway();
    await observeChat(gateway, adapter, channel.id);
    await gateway.bind({
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      role: "owner",
    });
    adapter.capabilities.media = true;

    await adapter.emit(
      inbound({
        accountId: channel.id,
        text: "",
        media: [
          {
            kind: "image",
            id: "photo-3",
            mimeType: "image/png",
            size: 6,
          },
        ],
        messageId: "18",
        updateId: "118",
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    if (errors.length) throw errors[0];
    await waitFor(() => adapter.sent.length === 1, "media reply");
    expect(adapter.mediaFetches).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("attached 1 file");
    expect(promptInputs[0]).toMatchObject({
      text: expect.stringContaining("untrusted message content"),
      files: [
        {
          mediaType: "image/png",
          filename: "photo.png",
          data: expect.any(String),
        },
      ],
    });
    await gateway.stop();
  });

  it("rejects outbound media on a text-only adapter without caching success", async () => {
    const { gateway, channel, adapter } = await setupGateway();

    await expect(
      gateway.send({
        accountId: channel.id,
        chat: { kind: "direct", id: "42" },
        text: "caption",
        media: [
          {
            kind: "image",
            mediaType: "image/png",
            data: "iVBORw0KGgo=",
          },
        ],
        mode: "proactive",
        idempotencyKey: "media-unsupported",
      })
    ).resolves.toEqual({
      status: "discard",
      reason: "media_not_supported",
    });
    expect(adapter.sent).toEqual([]);
    await gateway.stop();
  });

  it("keeps a thread id on the reply", async () => {
    const { gateway, channel, adapter, prompts } = await setupGateway();
    const chat: ImChat = {
      kind: "direct",
      id: "42",
      threadId: "77",
      title: "@owner",
    };
    await observeChat(gateway, adapter, channel.id, chat);
    await gateway.bind({ accountId: channel.id, chat, role: "owner" });
    await adapter.emit(
      inbound({
        accountId: channel.id,
        chat,
        text: "hello thread",
        messageId: "12",
        updateId: "112",
      })
    );
    await waitFor(() => adapter.sent.length === 1, "thread reply");
    expect(prompts).toEqual(["hello thread"]);
    expect(adapter.sent[0]!.chat).toMatchObject({
      kind: "direct",
      id: "42",
      threadId: "77",
    });
    await gateway.stop();
  });

  it("queues an owner message while the main Session is busy", async () => {
    let busy = true;
    const { gateway, channel, adapter, prompts } = await setupGateway({
      busy: () => busy,
      busyConfig: { retryMs: 5, noticeMs: 10, ttlMs: 2_000 },
    });
    await observeChat(gateway, adapter, channel.id);
    await gateway.bind({
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      role: "owner",
    });
    await adapter.emit(
      inbound({
        accountId: channel.id,
        text: "queued please",
        messageId: "13",
        updateId: "113",
      })
    );
    await waitFor(
      () => adapter.sent.some((message) => message.text.includes("busy")),
      "busy notice"
    );
    expect(prompts).toEqual([]);
    expect((await gateway.status()).pending).toBe(1);
    busy = false;
    await waitFor(() => prompts.length === 1, "queued prompt");
    await waitFor(
      () =>
        adapter.sent.some((message) => message.text === "echo: queued please"),
      "queued reply"
    );
    expect((await gateway.status()).pending).toBe(0);
    await gateway.stop();
  });

  it("joins a streaming turn as a follow-up instead of waiting", async () => {
    const { gateway, channel, adapter, prompts } = await setupGateway({
      busy: () => true,
      streaming: () => true,
    });
    await observeChat(gateway, adapter, channel.id);
    await gateway.bind({
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      role: "owner",
    });
    await adapter.emit(
      inbound({
        accountId: channel.id,
        text: "join the turn",
        messageId: "14",
        updateId: "114",
      })
    );
    await waitFor(() => prompts.length === 1, "follow-up prompt");
    expect(prompts).toEqual(["followUp:join the turn"]);
    await waitFor(() => adapter.sent.length === 1, "follow-up reply");
    await gateway.stop();
  });

  it("times out a queued owner message after the busy window", async () => {
    const { gateway, channel, adapter, prompts } = await setupGateway({
      busy: () => true,
      busyConfig: { retryMs: 5, noticeMs: 5_000, ttlMs: 20 },
    });
    await observeChat(gateway, adapter, channel.id);
    await gateway.bind({
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      role: "owner",
    });
    await adapter.emit(
      inbound({
        accountId: channel.id,
        text: "too late",
        messageId: "15",
        updateId: "115",
      })
    );
    await waitFor(
      () => adapter.sent.some((message) => message.text.includes("still busy")),
      "busy timeout"
    );
    expect(prompts).toEqual([]);
    expect((await gateway.status()).pending).toBe(0);
    await gateway.stop();
  });

  it("refuses a proactive send when the adapter cannot send one", async () => {
    const { gateway, channel, adapter } = await setupGateway();
    adapter.capabilities.proactive = false;
    adapter.capabilities.replyOnly = true;
    const unsupported = await gateway.send({
      platform: "telegram",
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      text: "hello",
      mode: "proactive",
      idempotencyKey: "proactive-unsupported",
    });
    expect(unsupported).toMatchObject({
      status: "discard",
      reason: "proactive_not_supported",
    });
    adapter.capabilities.proactive = true;
    adapter.canSendProactively = () => false;
    const closed = await gateway.send({
      platform: "telegram",
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      text: "hello",
      mode: "proactive",
      idempotencyKey: "proactive-closed",
    });
    expect(closed).toMatchObject({
      status: "discard",
      reason: "window_closed",
    });
    expect(adapter.sent).toEqual([]);
    await gateway.stop();
  });

  it("validates declared credentials before creating a channel", async () => {
    const { gateway } = await setupGateway({
      credentials: [{ key: "token", required: true }],
    });
    await expect(
      gateway.addChannel({
        platform: "telegram",
        label: "Missing token",
        credentials: { other: "value" },
      })
    ).rejects.toMatchObject({ code: "missing_credentials" });
    await gateway.stop();
  });

  it("registers a confirmed login as a channel without returning credentials", async () => {
    let token = "";
    const login: ImLoginAdapter = {
      async begin() {
        token = "123456789:AAHfakefakefakefakefakefakefakefake";
        return {
          id: "challenge-1",
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
    const { gateway, adapters } = await setupGateway({ login });
    const started = await gateway.beginLogin({
      platform: "telegram",
      label: "QR channel",
    });
    expect(started).toMatchObject({
      platform: "telegram",
      kind: "qr",
      state: "pending",
      content: "qr-payload",
    });
    const confirmed = await gateway.pollLogin(started.id);
    expect(confirmed).toMatchObject({ state: "confirmed" });
    expect(confirmed.accountId).toBeTruthy();
    expect(confirmed.content).toBeUndefined();
    expect(JSON.stringify(confirmed)).not.toContain(token);
    expect(adapters.get(confirmed.accountId!)).toBeDefined();
    await expect(gateway.pollLogin(started.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await gateway.stop();
  });

  it("resets a stored cursor when the bot identity changes", async () => {
    let identity = "bot-a";
    const first = await setupGateway({
      cursorIdentity: () => identity,
    });
    first.adapter.reportCursor("101");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await first.gateway.stop();

    const resumed = createImGateway({
      agent: first.agent,
      dir: first.dir,
      factories: [first.factory],
    });
    await resumed.start();
    expect(first.adapters.get(first.channel.id)?.createdWithCursor).toBe("101");
    await resumed.stop();

    identity = "bot-b";
    const restarted = createImGateway({
      agent: first.agent,
      dir: first.dir,
      factories: [first.factory],
    });
    await restarted.start();
    const adapter = first.adapters.get(first.channel.id);
    expect(adapter?.createdWithCursor).toBeUndefined();
    await restarted.stop();
  });

  it("deduplicates a redelivered Telegram update", async () => {
    const { gateway, channel, adapter, prompts } = await setupGateway();
    await observeChat(gateway, adapter, channel.id);
    await gateway.bind({
      accountId: channel.id,
      chat: { kind: "direct", id: "42" },
      role: "owner",
    });
    const message = inbound({
      accountId: channel.id,
      text: "Only once",
      messageId: "9",
      updateId: "109",
    });
    await adapter.emit(message);
    await adapter.emit(message);
    await waitFor(() => adapter.sent.length === 1, "first reply");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts).toEqual(["Only once"]);
    expect(adapter.sent).toHaveLength(1);
    await gateway.stop();
  });

  it("never sends group messages or guest chats to the model", async () => {
    const { gateway, channel, adapter, prompts } = await setupGateway();
    await observeChat(
      gateway,
      adapter,
      channel.id,
      { kind: "group", id: "-100", title: "Family" },
      { id: "7", name: "relative" }
    );
    await gateway.bind({
      accountId: channel.id,
      chat: { kind: "group", id: "-100", title: "Family" },
      role: "guest",
    });
    await adapter.emit(
      inbound({
        accountId: channel.id,
        chat: { kind: "group", id: "-100", title: "Family" },
        text: "hello",
        messageId: "11",
        updateId: "111",
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts).toEqual([]);
    expect(adapter.sent).toEqual([]);
    await gateway.stop();
  });

  it("rejects owner access to a group and a non-main Session", async () => {
    const { gateway, channel } = await setupGateway();
    await expect(
      gateway.bind({
        accountId: channel.id,
        chat: { kind: "group", id: "-100" },
        role: "owner",
      })
    ).rejects.toMatchObject({ code: "group_owner_not_supported" });
    await expect(
      gateway.bind({
        accountId: channel.id,
        chat: { kind: "direct", id: "42" },
        sessionId: "another-session",
      })
    ).rejects.toMatchObject({ code: "unsupported_session" });
    await gateway.stop();
  });

  it("suppresses a repeated outbound idempotency key", async () => {
    const { gateway, channel, adapter } = await setupGateway();
    const input = {
      platform: "telegram" as const,
      accountId: channel.id,
      chat: { kind: "direct" as const, id: "42" },
      text: "hello",
      mode: "proactive" as const,
      idempotencyKey: "same-key",
    };
    const first = await gateway.send(input);
    const second = await gateway.send(input);
    expect(first).toEqual(second);
    expect(adapter.sent).toHaveLength(1);
    const otherChat = await gateway.send({
      ...input,
      chat: { kind: "direct", id: "43" },
    });
    expect(otherChat.status).toBe("sent");
    expect(adapter.sent).toHaveLength(2);
    await gateway.stop();
  });

  it("persists accounts, bindings, conversations and dedupe across a restart", async () => {
    const first = await setupGateway();
    await observeChat(first.gateway, first.adapter, first.channel.id);
    await first.gateway.bind({
      accountId: first.channel.id,
      chat: { kind: "direct", id: "42" },
      role: "owner",
    });
    const message = inbound({
      accountId: first.channel.id,
      text: "remember me",
      messageId: "21",
      updateId: "121",
    });
    await first.adapter.emit(message);
    await waitFor(() => first.adapter.sent.length === 1, "first reply");
    await first.gateway.stop();

    const restarted = createImGateway({
      agent: first.agent,
      dir: first.dir,
      factories: [first.factory],
    });
    await restarted.start();
    const channels = await restarted.channels();
    expect(channels).toHaveLength(1);
    expect(channels[0]!.bindings).toBe(1);
    expect(await restarted.conversations()).toEqual([
      expect.objectContaining({ accountId: first.channel.id }),
    ]);
    const adapter = first.adapters.get(first.channel.id)!;
    await adapter.emit(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.prompts).toEqual(["remember me"]);
    await restarted.stop();
  });

  it("stops every adapter when Core is quiesced", async () => {
    const { gateway, adapter } = await setupGateway();
    await gateway.stop();
    expect(adapter.stopped).toBe(true);
    const channels = await gateway.channels();
    expect(channels[0]?.health.state).toBe("stopped");
  });
});
