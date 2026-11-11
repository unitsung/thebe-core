import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createFeishuChannelAdapter, createFeishuSource } from "./feishu.ts";

afterEach(() => vi.useRealTimers());

const provider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => "",
  getStatusSummary: async () => ({
    totalContainers: 0,
    runningContainers: 0,
    pausedContainers: 0,
    exitedContainers: 0,
    lastUpdated: 1,
  }),
} as unknown as ContainerInfoProvider;

const message = {
  message_id: "om_1",
  chat_id: "oc_chat",
  create_time: String(Date.parse("2026-11-11T09:00:00.000Z")),
  msg_type: "text",
  body: {
    content: JSON.stringify({ text: "The nightly backup stopped reporting." }),
  },
  sender: { id: { open_id: "ou_person" }, sender_type: "user" },
  mentions: [],
};

/** Feishu's Open API: token, chat mode, and messages per chat. */
function feishuApi() {
  let messages: unknown[] = [];
  const calls = { messages: 0 };
  const sent: Array<Record<string, unknown>> = [];
  const fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit
  ) => {
    const url = String(input);
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/tenant_access_token/internal")) {
      return reply({
        code: 0,
        tenant_access_token: "t",
        expire: 7200,
      });
    }
    if (url.includes("/open-apis/im/v1/chats/")) {
      return reply({ code: 0, data: { chat_mode: "group" } });
    }
    if (url.includes("/open-apis/im/v1/messages")) {
      if ((init?.method ?? "GET") === "GET") {
        calls.messages += 1;
        return reply({ code: 0, data: { items: messages, has_more: false } });
      }
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return reply({ code: 0, data: {} });
    }
    return reply({ code: 0, data: {} });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    sent,
    post: () => {
      messages = [message];
    },
  };
}

describe("Feishu Source through Eval and the Ticket executor", () => {
  it("turns an admitted group message into an inferred Ticket whose chat can write back", async () => {
    vi.useFakeTimers();
    const fake = createFakeRuntime();
    const api = feishuApi();
    const source = createFeishuSource({
      appId: "cli_app",
      appSecret: "secret",
      chats: ["oc_chat"],
      admitUnaddressed: true,
      fetch: api.fetch,
    });
    const app = createThebeApp({
      runtime: fake.runtime,
      provider,
      sources: { intervalMs: 1000 },
      sourceAdapters: [source],
    });

    await vi.advanceTimersByTimeAsync(0); // the chat baseline
    const policy = await app.agent.setPolicy({
      rules: ["Investigate a report that a nightly backup stopped"],
      acceptMode: "auto",
    });
    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [policy.rules[0]!.id],
          intent: "Investigate the stopped nightly backup",
          reason: "a person reported a stopped backup in a watched chat",
        }),
      },
      {
        kind: "text",
        text: "Read the report and checked the backup status; the last run completed.",
      },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: the report was read and the backup status checked\nREMAINING: none",
      },
    ]);

    api.post();
    await vi.advanceTimersByTimeAsync(1000);

    await vi.waitFor(async () => {
      expect(await app.agent.listTickets()).toHaveLength(1);
    });
    const [ticket] = await app.agent.listTickets();
    expect(api.calls.messages).toBe(2);
    expect(ticket).toMatchObject({
      title: "Investigate the stopped nightly backup",
      mandate: {
        strength: "inferred",
        decidedBy: "eval",
        intent: "Investigate the stopped nightly backup",
      },
      subscriptions: ["resource:feishu:chat:oc_chat"],
      origins: [
        {
          source: "feishu",
          actor: { source: "feishu", id: "ou_person" },
          human: true,
          admission: "inferred",
          channel: {
            source: "feishu",
            thread: "resource:feishu:chat:oc_chat",
            address: { chat: "oc_chat" },
          },
        },
      ],
      channels: [
        {
          source: "feishu",
          thread: "resource:feishu:chat:oc_chat",
          address: { chat: "oc_chat" },
        },
      ],
    });

    const goalId = ticket!.links.legacyGoalId!;
    await vi.waitFor(() =>
      expect(app.agent.getGoal(goalId)?.status).toBe("completed")
    );
    expect(
      (await app.agent.listSubagents(goalId)).map((run) => run.profileName)
    ).toEqual(["ticket-worker", "ticket-reviewer"]);

    const channel = createFeishuChannelAdapter({
      appId: "cli_app",
      appSecret: "secret",
    });
    expect(channel.accepts(ticket!.channels[0]!)).toBe(true);
    expect(
      channel.accepts({
        source: "feishu",
        thread: "resource:feishu:chat:not_a_chat!",
        address: { chat: "not a chat" },
      })
    ).toBe(false);

    await app.agent.quiesce();
  });

  it("writes a blocked Ticket's needs-person notice back to the chat", async () => {
    vi.useFakeTimers();
    const fake = createFakeRuntime();
    const api = feishuApi();
    const source = createFeishuSource({
      appId: "cli_app",
      appSecret: "secret",
      chats: ["oc_chat"],
      admitUnaddressed: true,
      fetch: api.fetch,
    });
    const channel = createFeishuChannelAdapter({
      appId: "cli_app",
      appSecret: "secret",
      chats: ["oc_chat"],
      fetch: api.fetch,
    });
    const app = createThebeApp({
      runtime: fake.runtime,
      provider,
      sources: { intervalMs: 1000 },
      sourceAdapters: [source],
      channelAdapters: [channel],
    });

    await vi.advanceTimersByTimeAsync(0);
    const policy = await app.agent.setPolicy({
      rules: ["Investigate a report that a nightly backup stopped"],
      acceptMode: "auto",
    });
    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [policy.rules[0]!.id],
          intent: "Investigate the stopped nightly backup",
          reason: "a person reported a stopped backup in a watched chat",
        }),
      },
      {
        kind: "tools",
        calls: [
          {
            name: "goal_report",
            args: {
              state: "blocked",
              blocker: "The backup drive is offline; reconnect it and resume.",
            },
            id: "call-report",
          },
        ],
      },
      { kind: "text", text: "Reported the offline backup drive." },
    ]);

    api.post();
    await vi.advanceTimersByTimeAsync(1000);

    await vi.waitFor(async () => {
      expect(await app.agent.listTickets()).toHaveLength(1);
    });
    const [ticket] = await app.agent.listTickets();
    const goalId = ticket!.links.legacyGoalId!;
    await vi.waitFor(() =>
      expect(app.agent.getGoal(goalId)).toMatchObject({
        status: "failed",
        blocked: true,
      })
    );

    await vi.waitFor(() => expect(api.sent).toHaveLength(1));
    const sent = api.sent[0]!;
    expect(sent.receive_id).toBe("oc_chat");
    expect(sent.uuid).toBeTruthy();
    const content = JSON.parse(String(sent.content)) as { text?: string };
    expect(content.text).toContain("A task is blocked and needs you");
    expect(content.text).toContain("The backup drive is offline");

    await app.agent.quiesce();
  });
});
