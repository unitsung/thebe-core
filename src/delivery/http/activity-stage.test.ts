import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { Aria2BackgroundTaskProvider } from "../../adapters/pipeline/aria2-tasks.ts";
import { Aria2DownloadProvider } from "../../adapters/pipeline/aria2-downloads.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import type { FakeQueuedTurn } from "../../testing/runtime/fixtures.ts";

const ORIGIN = "http://127.0.0.1:8787";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("inspect not used");
    },
    getContainerLogs: async () => {
      throw new Error("logs not used");
    },
    getStatusSummary: async () => {
      throw new Error("summary not used");
    },
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

type Body = Record<string, any>;

/** A worker or reviewer checkpoint that reports through the tool. A text turn follows each tool turn. */
function reports(
  ...states: Array<{ state: string; summary: string; question?: string }>
): FakeQueuedTurn[] {
  return states.flatMap((args) => [
    { kind: "tools" as const, calls: [{ name: "goal_report", args }] },
    { kind: "text" as const, text: "done" },
  ]);
}

const WORKER_READY = {
  state: "ready",
  summary: "Changed the code and ran the tests.",
};
const REVIEWER_READY = {
  state: "ready",
  summary: "pnpm test: all tests pass.",
};

function setup(
  options: {
    now?: () => Date;
    pushUrl?: boolean;
    backgroundTaskProviders?: any[];
  } = {}
) {
  const fake = createFakeRuntime();
  const pushed: Array<{ id: string; deepLink: string; relayDeviceId: string }> =
    [];
  const app = createThebeApp({
    runtime: fake.runtime,
    provider: provider(),
    now: options.now,
    backgroundTaskProviders: options.backgroundTaskProviders,
    ...(options.pushUrl
      ? {
          pushRelayUrl: "https://relay.example",
          pushFetch: (async (_url: string, init: RequestInit) => {
            pushed.push(JSON.parse(init.body as string));
            return new Response("{}");
          }) as unknown as typeof fetch,
        }
      : {}),
  });
  const call = async (
    path: string,
    init?: RequestInit
  ): Promise<{ status: number; body: Body }> => {
    const res = await app.handler.handle(new Request(`${ORIGIN}${path}`, init));
    return { status: res.status, body: (await res.json()) as Body };
  };
  const post = (path: string, body: unknown = {}) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const startGoal = async (goal = "Finish the refactor") => {
    const created = await post("/v1/goals", { goal, maxIterations: 3 });
    expect(created.status).toBe(201);
    return String(created.body.id);
  };
  const feed = async (query = "") =>
    (await call(`/v1/activity${query}`)).body.items as Body[];
  return { fake, app, call, post, startGoal, feed, pushed };
}

describe("stage on Activity items", () => {
  it("shows a goal asking one question as person/answer, and answering resumes the same session", async () => {
    const t = setup();
    t.fake.queueTurns(
      reports({
        state: "waiting",
        summary: "Two configs match.",
        question: "Which config should I change?",
      })
    );
    const id = await t.startGoal();
    await t.app.agent.waitGoal(id);

    const goal = await t.call(`/v1/goals/${id}`);
    expect(goal.body.status).toBe("paused");
    expect(goal.body.attention).toMatchObject({
      question: "Which config should I change?",
    });
    expect(goal.body.report).toMatchObject({
      state: "waiting",
      role: "worker",
    });

    const item = (await t.feed()).find((row) => row.id === id)!;
    expect(item.stage).toEqual({ kind: "person", reason: "answer" });
    // The same stage on the single-item path.
    expect((await t.call(`/v1/activity/${id}`)).body.stage).toEqual({
      kind: "person",
      reason: "answer",
    });

    // Answering resumes the same session and the goal finishes.
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const answered = await t.post(`/v1/goals/${id}/answer`, {
      answer: "The one in /etc/app.conf.",
    });
    expect(answered.status).toBe(200);
    expect(answered.body.id).toBe(id);
    expect(answered.body.attention).toBeUndefined();
    await t.app.agent.waitGoal(id);
    const done = await t.call(`/v1/goals/${id}`);
    expect(done.body).toMatchObject({ id, status: "succeeded" });
    expect((await t.call(`/v1/activity/${id}`)).body.stage).toEqual({
      kind: "ended",
    });
    // The answer reached the next worker checkpoint and was not repeated in later ones.
    const tasks = (await t.app.agent.listSubagents(id)).map((run) => run.task);
    expect(
      tasks.filter((task) => task.includes("The one in /etc/app.conf."))
    ).toHaveLength(1);
    expect(
      tasks.find((task) => task.includes("Which config should I change?"))
    ).toBeDefined();
  });

  it("allows one open question and rejects an answer when none is open", async () => {
    const t = setup();
    t.fake.queueTurns(
      reports({
        state: "waiting",
        summary: "Need input.",
        question: "Which one?",
      })
    );
    const id = await t.startGoal();
    await t.app.agent.waitGoal(id);

    expect(
      (await t.post(`/v1/goals/${id}/answer`, { answer: "  " })).status
    ).toBe(400);
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    expect(
      (await t.post(`/v1/session/${id}/goal/answer`, { answer: "This one" }))
        .status
    ).toBe(200);
    await t.app.agent.waitGoal(id);
    const again = await t.post(`/v1/goals/${id}/answer`, { answer: "Again" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("invalid_transition");
    expect(
      (await t.post("/v1/goals/missing/answer", { answer: "x" })).status
    ).toBe(404);
  });

  it("counts the question once and sends no second notice when it is answered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-attention-"));
    dirs.push(dir);
    const fake = createFakeRuntime();
    const pushed: Body[] = [];
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
      agentStoreDir: dir,
      pushRelayUrl: "https://relay.example",
      pushFetch: (async (_url: string, init: RequestInit) => {
        pushed.push(JSON.parse(init.body as string));
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    const send = async (path: string, body?: unknown) =>
      app.handler.handle(
        new Request(`${ORIGIN}${path}`, {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        })
      );
    await send("/v1/devices", {
      token: "apns-token",
      platform: "ios",
      relayDeviceId: "relay-1",
      categories: ["thebe.activity"],
    });
    fake.queueTurns(
      reports({
        state: "waiting",
        summary: "Need input.",
        question: "Which one?",
      })
    );
    const created = (await (
      await send("/v1/goals", { goal: "Ask me" })
    ).json()) as Body;
    await app.agent.waitGoal(created.id);
    await vi_waitFor(() => pushed.length === 1);
    expect(pushed[0]).toMatchObject({
      category: "thebe.activity",
      deepLink: `thebe://goal/${created.id}`,
    });

    fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    await send(`/v1/goals/${created.id}/answer`, { answer: "That one" });
    await app.agent.waitGoal(created.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushed).toHaveLength(1);
  });

  it("keeps a waiting goal and its one question across a Core restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-attention-restart-"));
    dirs.push(dir);
    const first = createFakeRuntime();
    const firstApp = createThebeApp({
      runtime: first.runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    first.queueTurns(
      reports({ state: "waiting", summary: "x", question: "Which one?" })
    );
    const created = await firstApp.handler.handle(
      new Request(`${ORIGIN}/v1/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "Survive a restart" }),
      })
    );
    const id = ((await created.json()) as Body).id as string;
    await firstApp.agent.waitGoal(id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The runtime outlives Core (it holds the sessions); only Core's own state is rebuilt from disk.
    const second = first;
    const secondApp = createThebeApp({
      runtime: second.runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const goal = (await (
      await secondApp.handler.handle(new Request(`${ORIGIN}/v1/goals/${id}`))
    ).json()) as Body;
    expect(goal.status).toBe("paused");
    expect(goal.attention).toMatchObject({ question: "Which one?" });
    const items = (
      (await (
        await secondApp.handler.handle(new Request(`${ORIGIN}/v1/activity`))
      ).json()) as Body
    ).items as Body[];
    expect(items.find((row) => row.id === id)!.stage).toEqual({
      kind: "person",
      reason: "answer",
    });
    second.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const answered = await secondApp.handler.handle(
      new Request(`${ORIGIN}/v1/goals/${id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "That one" }),
      })
    );
    expect(answered.status).toBe(200);
    await secondApp.agent.waitGoal(id);
    expect(
      (
        (await (
          await secondApp.handler.handle(
            new Request(`${ORIGIN}/v1/goals/${id}`)
          )
        ).json()) as Body
      ).status
    ).toBe("succeeded");
  });

  it("hands a blocked goal to the person and stops without using the remaining checkpoints", async () => {
    const t = setup();
    t.fake.queueTurns(
      reports({ state: "blocked", summary: "The disk is read-only." })
    );
    const id = await t.startGoal();
    await t.app.agent.waitGoal(id);
    const goal = await t.call(`/v1/goals/${id}`);
    expect(goal.body).toMatchObject({ status: "paused", iteration: 1 });
    expect(goal.body.attention).toBeUndefined();
    expect((await t.feed()).find((row) => row.id === id)!.stage).toEqual({
      kind: "person",
      reason: "blocked",
    });
    // Resuming settles the block.
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    await t.post(`/v1/goals/${id}/resume`);
    await t.app.agent.waitGoal(id);
    expect((await t.feed()).find((row) => row.id === id)!.stage).toEqual({
      kind: "ended",
    });
  });

  it("fails a goal whose worker reports failed, and ages the failure out after a day", async () => {
    let clock = new Date("2026-11-04T10:00:00Z");
    const t = setup({ now: () => clock });
    t.fake.queueTurns(
      reports({ state: "failed", summary: "The migration cannot be applied." })
    );
    const id = await t.startGoal();
    await t.app.agent.waitGoal(id);
    const goal = await t.call(`/v1/goals/${id}`);
    expect(goal.body).toMatchObject({ status: "failed", iteration: 1 });
    expect(goal.body.error.message).toBe("The migration cannot be applied.");
    expect((await t.feed()).find((row) => row.id === id)!.stage).toEqual({
      kind: "person",
      reason: "failed",
    });
    clock = new Date("2026-11-05T11:00:00Z");
    expect((await t.feed()).find((row) => row.id === id)!.stage).toEqual({
      kind: "ended",
    });
  });

  it("ends a goal without failing when the worker reports there was nothing to do", async () => {
    const t = setup();
    t.fake.queueTurns(
      reports({ state: "dropped", summary: "The library is already clean." })
    );
    const id = await t.startGoal();
    await t.app.agent.waitGoal(id);
    const goal = await t.call(`/v1/goals/${id}`);
    expect(goal.body.status).toBe("succeeded");
    expect(goal.body.summary).toContain("Nothing to do");
    expect((await t.feed()).find((row) => row.id === id)!.stage).toEqual({
      kind: "ended",
    });
  });

  it("keeps the older checkpoint footers working by reading them into a report", async () => {
    const t = setup();
    t.fake.queueTurns([
      {
        kind: "text",
        text: "GOAL_STATUS: complete\nCHECKPOINT: all done\nVERIFICATION: pnpm test\nREMAINING: none",
      },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: pnpm test — all tests pass\nREMAINING: none",
      },
    ]);
    const id = await t.startGoal();
    await t.app.agent.waitGoal(id);
    const goal = await t.call(`/v1/goals/${id}`);
    expect(goal.body.status).toBe("succeeded");
    expect(goal.body.report).toMatchObject({
      state: "ready",
      role: "reviewer",
    });
  });

  it("puts a running goal in the working stage and every item carries a stage", async () => {
    const t = setup();
    t.fake.queueTurns([{ kind: "hang" }]);
    const id = await t.startGoal();
    await vi_waitFor(
      async () =>
        (await t.call(`/v1/goals/${id}`)).body.currentRun?.status === "running"
    );
    const items = await t.feed();
    expect(items.every((row) => typeof row.stage?.kind === "string")).toBe(
      true
    );
    expect(items.find((row) => row.id === id)!.stage).toEqual({
      kind: "working",
    });
    await t.post(`/v1/goals/${id}/stop`);
    await t.app.agent.waitGoal(id);
  });

  it("keeps the existing group, source and status filters working beside stage", async () => {
    const t = setup();
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    const done = await t.startGoal("Done goal");
    await t.app.agent.waitGoal(done);
    t.fake.queueTurns(
      reports({ state: "waiting", summary: "x", question: "Which?" })
    );
    const asking = await t.startGoal("Asking goal");
    await t.app.agent.waitGoal(asking);

    const ids = (items: Body[]) => items.map((row) => row.id).sort();
    expect(ids(await t.feed("?source=goal"))).toEqual([asking, done].sort());
    expect(ids(await t.feed("?group=running"))).toEqual([asking]);
    expect(ids(await t.feed("?group=recent&source=goal"))).toEqual([done]);
    expect(ids(await t.feed("?status=succeeded"))).toEqual([done]);
    expect(ids(await t.feed("?stage=person"))).toEqual([asking]);
    expect(ids(await t.feed("?stage=ended&source=goal"))).toEqual([done]);
    expect((await t.call("/v1/activity?stage=nope")).status).toBe(400);
  });

  it("makes the needs-you count equal the list it opens, across pages", async () => {
    const t = setup();
    const askers: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      t.fake.queueTurns(
        reports({ state: "waiting", summary: "x", question: `Q${index}?` })
      );
      const id = await t.startGoal(`Asking ${index}`);
      await t.app.agent.waitGoal(id);
      askers.push(id);
    }
    t.fake.queueTurns(reports({ state: "blocked", summary: "stuck" }));
    const blocked = await t.startGoal("Blocked");
    await t.app.agent.waitGoal(blocked);
    t.fake.queueTurns(reports(WORKER_READY, REVIEWER_READY));
    await t.app.agent.waitGoal(
      await t
        .startGoal("Fine")
        .then(async (id) => (await t.app.agent.waitGoal(id), id))
    );

    const summary = (await t.call("/v1/activity/summary")).body.needsYou;
    expect(summary.count).toBe(4);
    expect(summary.reasons).toMatchObject({ answer: 3, blocked: 1, failed: 0 });
    // A page smaller than the list does not change the count; walking the pages gives the same length.
    const walked: Body[] = [];
    let cursor = "";
    for (;;) {
      const page = (await t.call(`/v1/activity?stage=person&limit=1${cursor}`))
        .body;
      walked.push(...page.items);
      if (!page.nextCursor) break;
      cursor = `&cursor=${page.nextCursor}`;
    }
    expect(walked).toHaveLength(summary.count);
    expect(walked.every((row) => row.stage.kind === "person")).toBe(true);
  });

  it("shows a goal whose worker waits on a tool confirmation as person/approval", async () => {
    const t = setup();
    t.fake.queueTurns([
      {
        kind: "tools",
        calls: [{ name: "write", args: { path: "a.txt", content: "x" } }],
      },
      { kind: "text", text: "wrote" },
    ]);
    const id = await t.startGoal();
    await vi_waitFor(
      async () => (await t.call("/v1/permissions")).body.permissions?.length > 0
    );
    expect((await t.feed()).find((row) => row.id === id)!.stage).toEqual({
      kind: "person",
      reason: "approval",
    });
    const permissions = (await t.call("/v1/permissions")).body
      .permissions as Body[];
    for (const permission of permissions) {
      await t.post(`/v1/permissions/${permission.id}`, { decision: "deny" });
    }
    await t.post(`/v1/goals/${id}/stop`);
    await t.app.agent.waitGoal(id).catch(() => undefined);
  });
});

describe("aria2 in Activity", () => {
  function aria2(rows: () => Array<Record<string, unknown>>) {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string };
      const all = rows();
      const pick = (status: string[]) =>
        all.filter((row) => status.includes(String(row.status)));
      const result =
        method === "aria2.tellActive"
          ? pick(["active"])
          : method === "aria2.tellWaiting"
            ? pick(["waiting", "paused"])
            : method === "aria2.tellStopped"
              ? pick(["complete", "error", "removed"])
              : [];
      return new Response(JSON.stringify({ result }));
    }) as unknown as typeof fetch;
    return new Aria2DownloadProvider({
      baseUrl: "http://aria2.local:6800",
      fetch: fetchImpl,
    });
  }
  const gid = (n: number) => String(n).padStart(16, "0");

  it("lists aria2 downloads as background tasks with a stage", async () => {
    let status = "active";
    const downloads = aria2(() => [
      {
        gid: gid(1),
        status,
        totalLength: "100",
        completedLength: "10",
        files: [{ path: "/d/movie.mkv" }],
      },
      {
        gid: gid(2),
        status: "complete",
        totalLength: "5",
        completedLength: "5",
        files: [{ path: "/d/old.iso" }],
      },
    ]);
    const t = setup({
      backgroundTaskProviders: [new Aria2BackgroundTaskProvider(downloads)],
    });
    const tasks = () => t.feed("?source=background_task");

    let items = await tasks();
    expect(items).toHaveLength(2);
    const running = items.find((row) => row.task.id === gid(1))!;
    expect(running).toMatchObject({
      type: "background_task",
      group: "running",
      task: { provider: "aria2", name: "movie.mkv" },
    });
    expect(running.stage).toEqual({ kind: "working" });
    expect(items.find((row) => row.task.id === gid(2))!.stage).toEqual({
      kind: "ended",
    });

    // A download that fails while Core is watching asks for the person.
    status = "error";
    items = await tasks();
    const failed = items.find((row) => row.task.id === gid(1))!;
    expect(failed.task.status).toBe("failed");
    expect(failed.stage).toEqual({ kind: "person", reason: "failed" });
    expect((await t.call("/v1/activity/summary")).body.needsYou.count).toBe(1);
    expect((await t.call(`/v1/activity/${failed.id}`)).body.stage).toEqual({
      kind: "person",
      reason: "failed",
    });
  });
});

async function vi_waitFor(
  check: () => boolean | Promise<boolean>
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
