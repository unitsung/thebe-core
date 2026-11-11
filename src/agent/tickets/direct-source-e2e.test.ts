import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import {
  createGithubChannelAdapter,
  createGithubSource,
} from "../../adapters/sources/github.ts";
import {
  createFeishuChannelAdapter,
  createFeishuSource,
} from "../../adapters/sources/feishu.ts";

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

const WORKER_BLOCKED = [
  {
    kind: "tools" as const,
    calls: [
      {
        name: "goal_report",
        args: {
          state: "blocked",
          blocker: "The backup account is missing; add it in the thread.",
        },
        id: "call-report",
      },
    ],
  },
  { kind: "text" as const, text: "Reported the missing backup account." },
];

/** GitHub's event feed and issue comments. The first comment POST is accepted by the server but lost in transit. */
function githubApi() {
  let events: unknown[] = [];
  const comments: string[] = [];
  const posts: string[] = [];
  let commentReads = 0;
  let loseNextPost = true;
  const fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit
  ) => {
    const url = String(input);
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/events")) return reply(events);
    if (url.includes("/comments")) {
      if ((init?.method ?? "GET") === "GET") {
        commentReads += 1;
        return reply(comments.map((body) => ({ body })));
      }
      const body = JSON.parse(String(init?.body)) as { body: string };
      posts.push(body.body);
      comments.push(body.body);
      if (loseNextPost) {
        loseNextPost = false;
        throw new Error("connection reset after the server accepted the comment");
      }
      return reply({ id: posts.length }, 201);
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    comments,
    posts,
    commentReads: () => commentReads,
    open: (event: unknown) => {
      events = [event];
    },
  };
}

const GITHUB_MENTION = {
  id: "evt-explicit-1",
  type: "IssueCommentEvent",
  actor: { login: "octocat", type: "User" },
  repo: { name: "acme/thebe" },
  created_at: "2026-11-11T09:00:00.000Z",
  payload: {
    action: "created",
    issue: {
      number: 7,
      title: "Nightly backup fails",
      html_url: "https://github.com/acme/thebe/issues/7",
      body: "The nightly backup stopped reporting.",
    },
    comment: {
      body: "@thebe-agent please check why the nightly backup stopped",
      html_url: "https://github.com/acme/thebe/issues/7#c1",
    },
  },
};

/** Feishu's Open API, deduplicating text messages by uuid as the real service does. */
function feishuApi() {
  let messages: unknown[] = [];
  const delivered: Array<{ uuid: string; text: string }> = [];
  const attempts: string[] = [];
  let loseNextPost = true;
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
      return reply({ code: 0, tenant_access_token: "t", expire: 7200 });
    }
    if (url.includes("/open-apis/im/v1/chats/")) {
      return reply({ code: 0, data: { chat_mode: "p2p" } });
    }
    if (url.includes("/open-apis/im/v1/messages")) {
      if ((init?.method ?? "GET") === "GET") {
        return reply({ code: 0, data: { items: messages, has_more: false } });
      }
      const body = JSON.parse(String(init?.body)) as {
        uuid: string;
        content: string;
      };
      attempts.push(body.uuid);
      const text = (JSON.parse(body.content) as { text: string }).text;
      if (!delivered.some((row) => row.uuid === body.uuid)) {
        delivered.push({ uuid: body.uuid, text });
      }
      if (loseNextPost) {
        loseNextPost = false;
        throw new Error("connection reset after the server accepted the message");
      }
      return reply({ code: 0, data: {} });
    }
    throw new Error(`unexpected Feishu request: ${url}`);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    delivered,
    attempts,
    post: (message: unknown) => {
      messages = [message];
    },
  };
}

const FEISHU_DIRECT = {
  message_id: "om_explicit_1",
  chat_id: "oc_direct",
  create_time: String(Date.parse("2026-11-11T09:00:00.000Z")),
  msg_type: "text",
  body: {
    content: JSON.stringify({
      text: "Please check why the nightly backup stopped.",
    }),
  },
  sender: { id: { open_id: "ou_person" }, sender_type: "user" },
  mentions: [],
};

async function startApp(input: {
  source: ReturnType<typeof createGithubSource> | ReturnType<typeof createFeishuSource>;
  channel: ReturnType<typeof createGithubChannelAdapter> | ReturnType<typeof createFeishuChannelAdapter>;
}) {
  vi.useFakeTimers();
  const dir = await mkdtemp(join(tmpdir(), "direct-source-e2e-"));
  const fake = createFakeRuntime();
  const app = createThebeApp({
    runtime: fake.runtime,
    provider,
    agentStoreDir: dir,
    sources: { intervalMs: 1000 },
    sourceAdapters: [input.source],
    channelAdapters: [input.channel],
  });
  await vi.advanceTimersByTimeAsync(0); // the Source baseline
  await vi.waitFor(() => {
    expect(app.agent.sourceHealth?.()[0]?.state).toBe("healthy");
  });
  return { app, fake };
}

/**
 * One explicit Source event, accepted by the Source itself, becomes a direct Ticket without Eval (explicit
 * requests belong to the person's Main Session path), runs on the isolated ticket worker, and writes a
 * blocked notice back through the Source's own channel. An accepted-but-lost first send is retried with the
 * same idempotency key and must not deliver twice.
 */
describe("explicit Source event to direct Ticket to idempotent writeback", () => {
  it("keeps a GitHub @mention's actor, human flag, channel and admission on the Ticket", async () => {
    const api = githubApi();
    const source = createGithubSource({
      repositories: ["acme/thebe"],
      agentLogin: "thebe-agent",
      fetch: api.fetch,
    });
    const channel = createGithubChannelAdapter({
      repositories: ["acme/thebe"],
      fetch: api.fetch,
    });
    const { app, fake } = await startApp({ source, channel });
    try {
      api.open(GITHUB_MENTION);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(async () => {
        expect(await app.agent.listTriggers()).toHaveLength(1);
      });
      const [trigger] = await app.agent.listTriggers();
      expect(trigger).toMatchObject({
        source: "github",
        kind: "github.issue.comment",
        human: true,
        admission: "explicit",
        addressed: "mention",
        actor: { source: "github", id: "octocat" },
        threads: ["resource:github:acme/thebe:issue:7"],
        channel: {
          source: "github",
          thread: "resource:github:acme/thebe:issue:7",
          address: { repo: "acme/thebe", issue: "7", kind: "issue" },
        },
      });

      // An explicit request is not weighed as inferred work: no Eval Decision is recorded.
      expect(await app.agent.listDecisions()).toEqual([]);

      fake.queueTurns(WORKER_BLOCKED);
      const first = await app.agent.delegateTicket({
        task: "Check why the nightly backup stopped",
        idempotencyKey: "github-explicit-request",
        triggerId: trigger!.id,
      });
      expect(first.reused).toBe(false);
      expect(first.ticket).toMatchObject({
        title: "Check why the nightly backup stopped",
        // The delegation path is the requester; the Source event is the provenance in `origins`.
        mandate: {
          strength: "explicit",
          decidedBy: "direct",
          requester: "http",
        },
        subscriptions: ["resource:github:acme/thebe:issue:7"],
        origins: [
          {
            triggerId: trigger!.id,
            source: "github",
            actor: { source: "github", id: "octocat" },
            human: true,
            admission: "explicit",
            addressed: "mention",
            channel: {
              source: "github",
              thread: "resource:github:acme/thebe:issue:7",
              address: { repo: "acme/thebe", issue: "7", kind: "issue" },
            },
          },
        ],
        channels: [
          {
            source: "github",
            thread: "resource:github:acme/thebe:issue:7",
            address: { repo: "acme/thebe", issue: "7", kind: "issue" },
          },
        ],
      });

      // The same Source event delegated again is the same Ticket and the same assignment.
      const retried = await app.agent.delegateTicket({
        task: "Check why the nightly backup stopped, again",
        idempotencyKey: "github-explicit-request-retry",
        triggerId: trigger!.id,
      });
      expect(retried).toMatchObject({
        reused: true,
        ticket: { id: first.ticket.id },
      });
      expect(await app.agent.listTickets()).toHaveLength(1);

      const goalId = first.ticket.links.legacyGoalId!;
      await vi.waitFor(() =>
        expect(app.agent.getGoal(goalId)).toMatchObject({
          status: "failed",
          blocked: true,
        })
      );
      // Execution is the isolated Ticket profile, not the parent conversation.
      expect(
        (await app.agent.listSubagents(goalId)).map((run) => run.profileName)
      ).toEqual(["ticket-worker"]);

      // The blocked notice reaches the issue through the Source's own channel, with its marker.
      await vi.waitFor(() => expect(api.posts).toHaveLength(1));
      expect(api.posts[0]).toContain("A task is blocked and needs you");
      expect(api.posts[0]).toContain("The backup account is missing");
      expect(api.posts[0]).toMatch(/<!-- thebe-notice:[a-f0-9]{32} -->/);

      // The first POST was accepted but the client saw a failure. The outbox retries; the marker makes
      // the adapter skip the second POST, so the issue holds exactly one comment.
      const readsBeforeRetry = api.commentReads();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() =>
        expect(api.commentReads()).toBeGreaterThan(readsBeforeRetry)
      );
      expect(api.posts).toHaveLength(1);
      expect(api.comments).toHaveLength(1);
      expect(await app.agent.listTickets()).toHaveLength(1);
    } finally {
      await app.agent.quiesce();
    }
  });

  it("keeps a Feishu direct message's actor, channel and admission, and retries its notice without a duplicate", async () => {
    const api = feishuApi();
    const source = createFeishuSource({
      appId: "cli_app",
      appSecret: "secret",
      chats: ["oc_direct"],
      fetch: api.fetch,
    });
    const channel = createFeishuChannelAdapter({
      appId: "cli_app",
      appSecret: "secret",
      chats: ["oc_direct"],
      fetch: api.fetch,
    });
    const { app, fake } = await startApp({ source, channel });
    try {
      api.post(FEISHU_DIRECT);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(async () => {
        expect(await app.agent.listTriggers()).toHaveLength(1);
      });
      const [trigger] = await app.agent.listTriggers();
      expect(trigger).toMatchObject({
        source: "feishu",
        kind: "feishu.message",
        human: true,
        admission: "explicit",
        addressed: "direct",
        actor: { source: "feishu", id: "ou_person" },
        threads: ["resource:feishu:chat:oc_direct"],
        channel: {
          source: "feishu",
          thread: "resource:feishu:chat:oc_direct",
          address: { chat: "oc_direct" },
        },
      });
      expect(await app.agent.listDecisions()).toEqual([]);

      fake.queueTurns(WORKER_BLOCKED);
      const first = await app.agent.delegateTicket({
        task: "Check why the nightly backup stopped",
        idempotencyKey: "feishu-explicit-request",
        triggerId: trigger!.id,
      });
      expect(first.reused).toBe(false);
      expect(first.ticket).toMatchObject({
        mandate: { strength: "explicit", decidedBy: "direct" },
        subscriptions: ["resource:feishu:chat:oc_direct"],
        origins: [
          {
            triggerId: trigger!.id,
            source: "feishu",
            actor: { source: "feishu", id: "ou_person" },
            human: true,
            admission: "explicit",
            addressed: "direct",
            channel: {
              source: "feishu",
              thread: "resource:feishu:chat:oc_direct",
              address: { chat: "oc_direct" },
            },
          },
        ],
        channels: [
          {
            source: "feishu",
            thread: "resource:feishu:chat:oc_direct",
            address: { chat: "oc_direct" },
          },
        ],
      });

      const goalId = first.ticket.links.legacyGoalId!;
      await vi.waitFor(() =>
        expect(app.agent.getGoal(goalId)).toMatchObject({
          status: "failed",
          blocked: true,
        })
      );
      expect(
        (await app.agent.listSubagents(goalId)).map((run) => run.profileName)
      ).toEqual(["ticket-worker"]);

      await vi.waitFor(() => expect(api.attempts).toHaveLength(1));
      expect(api.delivered).toHaveLength(1);
      expect(api.delivered[0]!.uuid).toMatch(/^[a-f0-9]{32}$/);
      expect(api.delivered[0]!.text).toContain("A task is blocked and needs you");
      expect(api.delivered[0]!.text).toContain("The backup account is missing");

      // The retry reuses the same uuid, which is Feishu's idempotency key for a text message.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(api.attempts).toHaveLength(2));
      expect(new Set(api.attempts).size).toBe(1);
      expect(api.delivered).toHaveLength(1);
      expect(await app.agent.listTickets()).toHaveLength(1);
    } finally {
      await app.agent.quiesce();
    }
  });
});
