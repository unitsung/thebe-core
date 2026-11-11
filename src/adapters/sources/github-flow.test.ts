import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createGithubChannelAdapter, createGithubSource } from "./github.ts";

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

const openedIssue = {
  id: "evt-1",
  type: "IssuesEvent",
  actor: { login: "octocat", type: "User" },
  repo: { name: "acme/thebe" },
  created_at: "2026-11-11T09:00:00.000Z",
  payload: {
    action: "opened",
    issue: {
      number: 7,
      title: "Nightly backup fails",
      html_url: "https://github.com/acme/thebe/issues/7",
      body: "The nightly backup stopped reporting.",
    },
  },
};

/** GitHub's event feed and issue comments: empty for the baseline read, then one opened issue. */
function githubFeed() {
  let events: unknown[] = [];
  const calls = { events: 0, comments: 0 };
  const comments: string[] = [];
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
    if (url.includes("/comments")) {
      if ((init?.method ?? "GET") === "GET") {
        return reply(comments.map((body) => ({ body })));
      }
      comments.push(
        String(
          (JSON.parse(String(init?.body)) as { body?: unknown }).body ?? ""
        )
      );
      calls.comments += 1;
      return reply({ id: comments.length }, 201);
    }
    calls.events += 1;
    return reply(events);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    comments,
    open: () => {
      events = [openedIssue];
    },
  };
}

describe("GitHub Source through Eval and the Ticket executor", () => {
  it("turns an opened issue into an inferred Ticket whose channel can write back", async () => {
    vi.useFakeTimers();
    const fake = createFakeRuntime();
    const feed = githubFeed();
    const source = createGithubSource({
      repositories: ["acme/thebe"],
      agentLogin: "thebe-agent",
      fetch: feed.fetch,
    });
    const app = createThebeApp({
      runtime: fake.runtime,
      provider,
      sources: { intervalMs: 1000 },
      sourceAdapters: [source],
    });

    await vi.advanceTimersByTimeAsync(0); // the repository baseline
    const policy = await app.agent.setPolicy({
      rules: ["Investigate a newly opened issue"],
      acceptMode: "auto",
    });
    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [policy.rules[0]!.id],
          intent: "Investigate the newly opened issue",
          reason: "a person opened an issue in a watched repository",
        }),
      },
      {
        kind: "text",
        text: "Read the issue and checked the reported state; nothing is broken now.",
      },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: the issue was read and the reported state checked\nREMAINING: none",
      },
    ]);

    feed.open();
    await vi.advanceTimersByTimeAsync(1000);

    await vi.waitFor(async () => {
      expect(await app.agent.listTickets()).toHaveLength(1);
    });
    const [ticket] = await app.agent.listTickets();
    expect(feed.calls.events).toBe(2);
    expect(ticket).toMatchObject({
      title: "Investigate the newly opened issue",
      mandate: {
        strength: "inferred",
        decidedBy: "eval",
        intent: "Investigate the newly opened issue",
      },
      subscriptions: ["resource:github:acme/thebe:issue:7"],
      origins: [
        {
          source: "github",
          actor: { source: "github", id: "octocat" },
          human: true,
          admission: "inferred",
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

    // Execution stays on the isolated Ticket profiles; the parent transcript is not reused.
    const goalId = ticket!.links.legacyGoalId!;
    await vi.waitFor(() =>
      expect(app.agent.getGoal(goalId)?.status).toBe("completed")
    );
    expect(
      (await app.agent.listSubagents(goalId)).map((run) => run.profileName)
    ).toEqual(["ticket-worker", "ticket-reviewer"]);

    // The ChannelRef the Source produced is one the writeback adapter accepts, and only inside
    // the configured repository.
    const channel = createGithubChannelAdapter({
      repositories: ["acme/thebe"],
    });
    expect(channel.accepts(ticket!.channels[0]!)).toBe(true);
    expect(
      channel.accepts({
        source: "github",
        thread: "resource:github:other/repo:issue:1",
        address: { repo: "other/repo", issue: "1", kind: "issue" },
      })
    ).toBe(false);

    await app.agent.quiesce();
  });

  it("writes a completed Ticket's result back to the issue once", async () => {
    vi.useFakeTimers();
    const fake = createFakeRuntime();
    const feed = githubFeed();
    const source = createGithubSource({
      repositories: ["acme/thebe"],
      agentLogin: "thebe-agent",
      fetch: feed.fetch,
    });
    const channel = createGithubChannelAdapter({
      repositories: ["acme/thebe"],
      fetch: feed.fetch,
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
      rules: ["Investigate a newly opened issue"],
      acceptMode: "auto",
    });
    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [policy.rules[0]!.id],
          intent: "Investigate the newly opened issue",
          reason: "a person opened an issue in a watched repository",
        }),
      },
      {
        kind: "text",
        text: "Read the issue and checked the reported state; nothing is broken now.",
      },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: the issue was read and the reported state checked\nREMAINING: none",
      },
    ]);

    feed.open();
    await vi.advanceTimersByTimeAsync(1000);

    await vi.waitFor(async () => {
      expect(await app.agent.listTickets()).toHaveLength(1);
    });
    const [ticket] = await app.agent.listTickets();
    const goalId = ticket!.links.legacyGoalId!;
    await vi.waitFor(() =>
      expect(app.agent.getGoal(goalId)?.status).toBe("completed")
    );

    await vi.waitFor(() => expect(feed.comments).toHaveLength(1));
    expect(feed.comments[0]).toContain("A task is complete");
    expect(feed.comments[0]).toContain("<!-- thebe-notice:");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(feed.comments).toHaveLength(1);

    await app.agent.quiesce();
  });

  it("writes a blocked Ticket's needs-person notice back to the issue", async () => {
    vi.useFakeTimers();
    const fake = createFakeRuntime();
    const feed = githubFeed();
    const source = createGithubSource({
      repositories: ["acme/thebe"],
      agentLogin: "thebe-agent",
      fetch: feed.fetch,
    });
    const channel = createGithubChannelAdapter({
      repositories: ["acme/thebe"],
      fetch: feed.fetch,
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
      rules: ["Investigate a newly opened issue"],
      acceptMode: "auto",
    });
    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [policy.rules[0]!.id],
          intent: "Investigate the newly opened issue",
          reason: "a person opened an issue in a watched repository",
        }),
      },
      {
        kind: "tools",
        calls: [
          {
            name: "goal_report",
            args: {
              state: "blocked",
              blocker:
                "The backup account is missing; add it in the issue thread.",
            },
            id: "call-report",
          },
        ],
      },
      { kind: "text", text: "Reported the missing backup account." },
    ]);

    feed.open();
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

    // The outbox sends through the same ChannelRef the Source stored on the Ticket, and the
    // adapter deduplicates retries with the marker it writes into the comment.
    await vi.waitFor(() => expect(feed.comments).toHaveLength(1));
    expect(feed.comments[0]).toContain("A task is blocked and needs you");
    expect(feed.comments[0]).toContain("The backup account is missing");
    expect(feed.comments[0]).toContain("<!-- thebe-notice:");

    await app.agent.quiesce();
  });
});
