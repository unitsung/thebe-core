import { describe, expect, it } from "vitest";
import {
  createGithubChannelAdapter,
  createGithubFromEnv,
  createGithubSource,
} from "./github.ts";

type Feed = Record<string, unknown>[];

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "1001",
    type: "IssueCommentEvent",
    actor: { login: "unitsung", type: "User" },
    repo: { name: "unitsung/thebe" },
    created_at: "2026-11-11T09:00:00Z",
    payload: {
      action: "created",
      issue: {
        number: 12,
        title: "Restart the media container",
        body: "It stopped again.",
        html_url: "https://github.com/unitsung/thebe/issues/12",
      },
      comment: {
        body: "Please fix this, it keeps stopping.",
        html_url: "https://github.com/unitsung/thebe/issues/12#c1",
      },
    },
    ...overrides,
  };
}

function fakeGithub(initial: Feed) {
  let feed = initial;
  let etag = '"v1"';
  let status = 200;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetcher = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) }
        : {}),
    });
    if (url.includes("/events")) {
      if (status === 304) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(feed), {
        status,
        headers: { etag },
      });
    }
    if (url.includes("/comments") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  };
  return {
    fetcher: fetcher as typeof fetch,
    calls,
    setFeed(next: Feed) {
      feed = next;
      etag = '"v2"';
    },
    setStatus(next: number) {
      status = next;
    },
  };
}

describe("GitHub Source", () => {
  it("takes a baseline and reports a new human comment with actor, channel and admission", async () => {
    const github = fakeGithub([event()]);
    const source = createGithubSource({
      repositories: ["unitsung/thebe"],
      agentLogin: "thebe-agent",
      fetch: github.fetcher,
      now: () => new Date("2026-11-11T10:00:00Z"),
    });

    const baseline = await source.read(undefined);
    expect(baseline.triggers).toEqual([]);

    github.setFeed([
      event({
        id: "1002",
        created_at: "2026-11-11T09:30:00Z",
        payload: {
          action: "created",
          issue: { number: 12, title: "Restart the media container" },
          comment: { body: "@thebe-agent please restart emby" },
        },
      }),
    ]);
    const read = await source.read(baseline.cursor);
    expect(read.triggers).toHaveLength(1);
    expect(read.triggers[0]).toMatchObject({
      source: "github",
      kind: "github.issue.comment",
      threads: ["resource:github:unitsung/thebe:issue:12"],
      resource: { kind: "github", id: "unitsung/thebe#issue/12" },
      actor: { source: "github", id: "unitsung" },
      human: true,
      admission: "explicit",
      addressed: "mention",
      channel: {
        source: "github",
        thread: "resource:github:unitsung/thebe:issue:12",
        address: { repo: "unitsung/thebe", issue: "12", kind: "issue" },
      },
    });
    expect(read.triggers[0]?.payload).toMatchObject({
      issue: 12,
      body: "@thebe-agent please restart emby",
    });
  });

  it("ignores bot events and unaddressed comments without reaching a model", async () => {
    const github = fakeGithub([event()]);
    const source = createGithubSource({
      repositories: ["unitsung/thebe"],
      agentLogin: "thebe-agent",
      fetch: github.fetcher,
    });
    const baseline = await source.read(undefined);

    github.setFeed([
      event({
        id: "2001",
        actor: { login: "dependabot[bot]", type: "Bot" },
        payload: {
          action: "created",
          issue: { number: 12 },
          comment: { body: "@thebe-agent bump" },
        },
      }),
      event({
        id: "2002",
        payload: {
          action: "created",
          issue: { number: 12 },
          comment: { body: "just a note, no mention" },
        },
      }),
    ]);
    const read = await source.read(baseline.cursor);
    expect(read.triggers).toHaveLength(2);
    expect(read.triggers.map((trigger) => trigger.admission)).toEqual([
      "ignore",
      "ignore",
    ]);
    expect(read.triggers[0]).toMatchObject({ human: false });
    expect(read.triggers[1]).toMatchObject({
      human: true,
      actor: { id: "unitsung" },
    });
  });

  it("treats a newly opened issue as inferred work for Eval", async () => {
    const github = fakeGithub([event()]);
    const source = createGithubSource({
      repositories: ["unitsung/thebe"],
      fetch: github.fetcher,
    });
    const baseline = await source.read(undefined);
    github.setFeed([
      event({
        id: "3001",
        type: "IssuesEvent",
        payload: {
          action: "opened",
          issue: {
            number: 13,
            title: "Backup failed",
            body: "The nightly backup reports an error.",
          },
        },
      }),
    ]);
    const read = await source.read(baseline.cursor);
    expect(read.triggers[0]).toMatchObject({
      kind: "github.issue.opened",
      admission: "inferred",
      human: true,
    });
  });

  it("uses conditional requests and keeps a stable Trigger id", async () => {
    const github = fakeGithub([]);
    const source = createGithubSource({
      repositories: ["unitsung/thebe"],
      fetch: github.fetcher,
    });
    const baseline = await source.read(undefined);
    github.setFeed([event({ id: "4001" })]);
    const first = await source.read(baseline.cursor);
    expect(first.triggers).toHaveLength(1);
    const again = await source.read(baseline.cursor);
    expect(again.triggers[0]?.id).toBe(first.triggers[0]?.id);
    expect(first.triggers[0]?.id).toMatch(/^[a-f0-9]{32}$/);
    expect((await source.read(first.cursor)).triggers).toEqual([]);
    expect(
      github.calls.some(
        (call) => call.method === "GET" && call.url.includes("/events")
      )
    ).toBe(true);
  });

  it("treats a 304 response as no news and keeps the cursor", async () => {
    const github = fakeGithub([]);
    const source = createGithubSource({
      repositories: ["unitsung/thebe"],
      fetch: github.fetcher,
    });
    const baseline = await source.read(undefined);
    github.setStatus(304);

    const read = await source.read(baseline.cursor);

    expect(read.triggers).toEqual([]);
    expect(read.cursor).toBe(baseline.cursor);
  });

  it("reads the second page before stopping", async () => {
    const pages = new Map<string, unknown[]>();
    const requested: string[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (!url.includes("/events")) return Response.json([]);
      requested.push(url);
      const page = new URL(url).searchParams.get("page") ?? "1";
      return Response.json(pages.get(page) ?? [], {
        headers: { etag: '"pages"' },
      });
    }) as typeof fetch;
    const mention = (id: string, seconds: number) =>
      event({
        id,
        created_at: new Date(
          Date.parse("2026-11-11T10:00:00.000Z") + seconds * 1000
        ).toISOString(),
        payload: {
          action: "created",
          issue: { number: 12, title: "Restart the media container" },
          comment: { body: "@thebe-agent please restart emby" },
        },
      });
    pages.set("1", [
      event({
        id: "1000",
        created_at: "2026-11-11T09:00:00.000Z",
        payload: {
          action: "created",
          issue: { number: 12 },
          comment: { body: "just a note" },
        },
      }),
    ]);
    const source = createGithubSource({
      repositories: ["unitsung/thebe"],
      agentLogin: "thebe-agent",
      fetch: fetcher,
    });
    const baseline = await source.read(undefined);

    pages.set(
      "1",
      Array.from({ length: 100 }, (_, index) => mention(`p1-${index}`, index))
    );
    pages.set("2", [mention("p2-0", 1000)]);
    const read = await source.read(baseline.cursor);

    expect(read.triggers).toHaveLength(101);
    expect(read.triggers[0]).toMatchObject({
      admission: "explicit",
      addressed: "mention",
    });
    expect(read.triggers.at(-1)?.actor).toEqual({
      source: "github",
      id: "unitsung",
    });
    expect(
      requested.some((url) => url.includes("page=1")),
      requested.join("\n")
    ).toBe(true);
    expect(
      requested.some((url) => url.includes("page=2")),
      requested.join("\n")
    ).toBe(true);
    expect(requested.some((url) => url.includes("page=3"))).toBe(false);
  });

  it("reports a repository read failure instead of silently advancing", async () => {
    const github = fakeGithub([]);
    github.setStatus(500);
    const source = createGithubSource({
      repositories: ["unitsung/thebe"],
      fetch: github.fetcher,
    });
    await expect(source.read(undefined)).rejects.toThrow(
      "GitHub events for unitsung/thebe failed: 500"
    );
  });
});

describe("GitHub Channel", () => {
  it("writes a notice as an idempotent issue comment", async () => {
    const comments: string[] = [];
    const posts: Array<Record<string, unknown>> = [];
    const fetcher = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify(comments.map((body) => ({ body }))),
          { status: 200 }
        );
      }
      posts.push(JSON.parse(String(init?.body)));
      comments.push(String(posts.at(-1)?.body));
      return new Response(JSON.stringify({ id: posts.length }), {
        status: 201,
      });
    }) as typeof fetch;
    const adapter = createGithubChannelAdapter({
      fetch: fetcher,
      repositories: ["unitsung/thebe"],
    });
    const channel = {
      source: "github",
      thread: "resource:github:unitsung/thebe:issue:12",
      address: { repo: "unitsung/thebe", issue: "12" },
    };
    expect(adapter.accepts(channel)).toBe(true);
    expect(
      adapter.accepts({
        ...channel,
        address: { repo: "evil/repo", issue: "1" },
      })
    ).toBe(false);

    const input = {
      channel,
      notice: {
        id: "n1",
        ticketId: "t1",
        goalId: "g1",
        type: "goal_needs_person" as const,
        reason: "review" as const,
        message: "Work is ready for your review.",
      },
      idempotencyKey: "a".repeat(32),
    };
    await adapter.send(input);
    await adapter.send(input);
    expect(posts).toHaveLength(1);
    expect(String(posts[0]?.body)).toContain("Work is ready for your review.");
    expect(String(posts[0]?.body)).toContain(
      `<!-- thebe-notice:${"a".repeat(32)} -->`
    );
  });

  it("finds an idempotency marker beyond the first page of comments", async () => {
    const marker = `<!-- thebe-notice:${"b".repeat(32)} -->`;
    const pages: Array<Array<{ body: string }>> = [
      Array.from({ length: 100 }, (_, index) => ({ body: `comment ${index}` })),
      [{ body: `earlier notice\n${marker}` }],
    ];
    const requestedPages: number[] = [];
    const posts: Array<Record<string, unknown>> = [];
    const fetcher = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET") {
        const page = Number(url.searchParams.get("page") ?? "1");
        requestedPages.push(page);
        return Response.json(pages[page - 1] ?? []);
      }
      posts.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 1 }, { status: 201 });
    }) as typeof fetch;
    const adapter = createGithubChannelAdapter({
      fetch: fetcher,
      repositories: ["unitsung/thebe"],
    });

    await adapter.send({
      channel: {
        source: "github",
        thread: "resource:github:unitsung/thebe:issue:12",
        address: { repo: "unitsung/thebe", issue: "12" },
      },
      notice: {
        id: "n2",
        ticketId: "t1",
        goalId: "g1",
        type: "goal_needs_person",
        reason: "review",
        message: "Work is ready for your review.",
      },
      idempotencyKey: "b".repeat(32),
    });

    expect(requestedPages).toEqual([1, 2]);
    expect(posts).toHaveLength(0);
  });
});

describe("GitHub environment wiring", () => {
  it("is off without repositories and needs no token", () => {
    expect(createGithubFromEnv({})).toBeUndefined();
    const integration = createGithubFromEnv({
      THEBE_GITHUB_REPOS: "unitsung/thebe, other/repo",
      THEBE_GITHUB_AGENT_LOGIN: "thebe-agent",
    });
    expect(integration?.source.id).toBe("github");
    expect(integration?.channel.id).toBe("github");
  });
});
