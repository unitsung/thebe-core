import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerInfoProvider,
  ContainerState,
} from "../../agent/capabilities/containers.ts";
import type { AgentRuntime } from "../../agent/runtime/interface.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

type FakeWorld = {
  containers: Record<string, ContainerState>;
};

function createDockerProvider(world: FakeWorld): ContainerInfoProvider {
  return {
    listContainers: async () =>
      Object.entries(world.containers).map(([name, state]) => ({
        id: `id-${name}`,
        name,
        image: `img/${name}`,
        state,
        status: state,
        created: 1,
      })),
    inspectContainer: async (id: string) => ({
      id,
      name: id,
      image: "img",
      state: "running",
      config: { env: [], labels: {} },
    }),
    getContainerLogs: async () => "",
    getStatusSummary: async () => ({
      totalContainers: Object.keys(world.containers).length,
      runningContainers: Object.values(world.containers).filter(
        (s) => s === "running"
      ).length,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  } as unknown as ContainerInfoProvider;
}

function setup(options: { agentStoreDir?: string; intervalMs?: number } = {}) {
  const world: FakeWorld = {
    containers: {
      emby: "running",
      sonarr: "running",
    },
  };
  const fake = createFakeRuntime();
  const prompted: string[] = [];
  const assessed: string[] = [];

  const runtime: AgentRuntime = {
    ...fake.runtime,
    createSession: async (create) => {
      const session = await fake.runtime.createSession(create);
      return {
        ...session,
        prompt: async (input) => {
          const text = typeof input === "string" ? input : input.text;
          prompted.push(text);
          if (text.includes("You decide whether events seen")) {
            assessed.push(text);
          }
          return session.prompt(input);
        },
      };
    },
  };

  const app = createThebeApp({
    runtime,
    provider: createDockerProvider(world),
    sources: { containerHealth: true, intervalMs: options.intervalMs ?? 1000 },
    agentStoreDir: options.agentStoreDir,
  });

  const call = async (path: string, init?: RequestInit) => {
    const res = await app.handler.handle(
      new Request(`http://127.0.0.1:8787${path}`, {
        ...init,
        headers: { "content-type": "application/json" },
      })
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  };

  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", body: JSON.stringify(body) });

  return { world, fake, app, runtime, prompted, assessed, call, post };
}

const ASKING_REPORT = [
  {
    kind: "tools" as const,
    calls: [
      {
        name: "goal_report",
        args: {
          state: "ask",
          question: "Which container?",
          options: ["emby", "sonarr"],
        },
      },
    ],
  },
  { kind: "text" as const, text: "waiting" },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("subscriptions and fan-out", () => {
  it("attaches a subsequent event on a subscribed container to an open ticket and triggers no assessment", async () => {
    vi.useFakeTimers();
    const t = setup();
    await vi.advanceTimersByTimeAsync(0); // Source baseline read

    // Configure policy with a rule so any non-subscribed event would trigger assessment
    await t.app.agent.setPolicy({
      rules: ["If a media server stops, it is worth looking into."],
      acceptMode: "observe",
    });

    // Worker creates a task paused on attention, subscribed to emby container
    t.fake.queueTurns(ASKING_REPORT);
    const goalRes = await t.post("/v1/goals", {
      goal: "Check emby health",
      threads: ["resource:container:emby"],
      allowAsk: true,
    });
    expect(goalRes.status).toBe(201);
    const ticketId = goalRes.body.ticketId as string;
    expect(ticketId).toBeDefined();
    await t.app.agent.waitGoal(goalRes.body.id);

    // Verify ticket has subscription and empty inputs
    const ticketBefore = (await t.call(`/v1/tickets/${ticketId}`)).body;
    expect(ticketBefore.subscriptions).toContain("resource:container:emby");
    expect(ticketBefore.inputs).toEqual([]);

    const promptsBefore = t.prompted.length;
    expect(t.assessed).toHaveLength(0);

    // Emby turns exited (triggering container.went_down)
    t.world.containers.emby = "exited";
    await vi.advanceTimersByTimeAsync(1000); // trigger next poll tick

    // Fan-out attached the trigger to the open ticket!
    // No model calls of any kind made for the event!
    await vi.waitFor(async () => {
      const res = await t.call(`/v1/tickets/${ticketId}`);
      expect(res.body.inputs).toHaveLength(1);
    });
    expect(t.prompted.length).toBe(promptsBefore);
    expect(t.assessed).toHaveLength(0);

    // Ticket now has the attached input
    const ticketAfter = (await t.call(`/v1/tickets/${ticketId}`)).body;
    expect(ticketAfter.inputs[0]).toMatchObject({
      seq: 1,
      source: "container-health",
      kind: "container.went_down",
      thread: "resource:container:emby",
    });

    // Emby recovers (container.recovered) while ticket is still open
    t.world.containers.emby = "running";
    await vi.advanceTimersByTimeAsync(1000);

    // Second event attached as input seq 2, still 0 assessment model calls
    await vi.waitFor(async () => {
      const res = await t.call(`/v1/tickets/${ticketId}`);
      expect(res.body.inputs).toHaveLength(2);
    });
    expect(t.prompted.length).toBe(promptsBefore);
    expect(t.assessed).toHaveLength(0);

    const ticketRecovered = (await t.call(`/v1/tickets/${ticketId}`)).body;
    expect(ticketRecovered.inputs.map((i: any) => [i.seq, i.kind])).toEqual([
      [1, "container.went_down"],
      [2, "container.recovered"],
    ]);
  });

  it("sends an event on an unsubscribed thread through Gate and Assessment", async () => {
    vi.useFakeTimers();
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);

    const policy = await t.app.agent.setPolicy({
      rules: ["Restart a stopped container."],
      acceptMode: "observe",
    });

    // Ticket is only subscribed to emby
    t.fake.queueTurns(ASKING_REPORT);
    const goalRes = await t.post("/v1/goals", {
      goal: "Fix emby",
      threads: ["resource:container:emby"],
      allowAsk: true,
    });
    const ticketId = goalRes.body.ticketId as string;
    await t.app.agent.waitGoal(goalRes.body.id);

    // Queue assessment answer for when sonarr goes down
    t.fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "accept",
          matched: [policy.rules[0]!.id],
          intent: "restart sonarr",
          reason: "sonarr went down",
        }),
      },
    ]);

    // Sonarr goes down (unsubscribed!)
    t.world.containers.sonarr = "exited";
    await vi.advanceTimersByTimeAsync(1000);

    // Assessment was invoked for sonarr!
    await vi.waitFor(() => expect(t.assessed).toHaveLength(1));
    expect(t.assessed[0]).toContain('"id":"sonarr"');
    expect(t.assessed[0]).not.toContain('"id":"emby"');

    // The emby ticket received no inputs from sonarr
    const ticket = (await t.call(`/v1/tickets/${ticketId}`)).body;
    expect(ticket.inputs).toEqual([]);
  });

  it("stops sending events to a ticket whose goal has ended", async () => {
    vi.useFakeTimers();
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);

    await t.app.agent.setPolicy({
      rules: ["Inspect stopped containers."],
      acceptMode: "observe",
    });

    // Start a goal that completes immediately
    t.fake.queueTurns([
      {
        kind: "text",
        text: "Checked emby\nGOAL_STATUS: complete\nVERIFICATION: checked\nREMAINING: none",
      },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: all good\nREMAINING: none",
      },
    ]);
    const goalRes = await t.post("/v1/goals", {
      goal: "Check emby once",
      threads: ["resource:container:emby"],
      maxIterations: 1,
    });
    const ticketId = goalRes.body.ticketId as string;
    await t.app.agent.waitGoal(goalRes.body.id);

    // Goal is now complete (ended)
    const goal = (await t.call(`/v1/goals/${goalRes.body.id}`)).body;
    expect(goal.status).toBe("succeeded");

    // Queue assessment response for when emby goes down now
    t.fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          decision: "ignore",
          matched: [],
          reason: "already checked",
        }),
      },
    ]);

    // Emby goes down after the ticket ended
    t.world.containers.emby = "exited";
    await vi.advanceTimersByTimeAsync(1000);

    // Because the ticket ended, the event was NOT attached and went to assessment!
    await vi.waitFor(() => expect(t.assessed).toHaveLength(1));
    const ticket = (await t.call(`/v1/tickets/${ticketId}`)).body;
    expect(ticket.inputs).toEqual([]);
  });

  it("gives an event to the newest live ticket when two share a subscription", async () => {
    vi.useFakeTimers();
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);

    t.fake.queueTurns([...ASKING_REPORT, ...ASKING_REPORT]);

    // Create first ticket
    const goal1 = await t.post("/v1/goals", {
      goal: "First monitor",
      threads: ["resource:container:emby"],
      allowAsk: true,
    });
    const ticket1 = goal1.body.ticketId;
    await t.app.agent.waitGoal(goal1.body.id);

    // Advance 5 seconds and create second ticket
    await vi.advanceTimersByTimeAsync(5000);
    const goal2 = await t.post("/v1/goals", {
      goal: "Second monitor",
      threads: ["resource:container:emby"],
      allowAsk: true,
    });
    const ticket2 = goal2.body.ticketId;
    expect(ticket2).not.toBe(ticket1);
    await t.app.agent.waitGoal(goal2.body.id);

    // Emby goes down
    t.world.containers.emby = "exited";
    await vi.advanceTimersByTimeAsync(1000);

    // Only ticket2 (newest) receives the input!
    await vi.waitFor(async () => {
      const res = await t.call(`/v1/tickets/${ticket2}`);
      expect(res.body.inputs).toHaveLength(1);
    });
    const t1 = (await t.call(`/v1/tickets/${ticket1}`)).body;
    const t2 = (await t.call(`/v1/tickets/${ticket2}`)).body;
    expect(t1.inputs).toHaveLength(0);
    expect(t2.inputs).toHaveLength(1);
    expect(t2.inputs[0]?.kind).toBe("container.went_down");
  });

  it("survives a restart and preserves subscriptions and attached inputs", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "thebe-fan-out-restart-"));
    const t1 = setup({ agentStoreDir: dir });
    await vi.advanceTimersByTimeAsync(0);

    t1.fake.queueTurns(ASKING_REPORT);
    const goal = await t1.post("/v1/goals", {
      goal: "Maintain emby",
      threads: ["resource:container:emby"],
      allowAsk: true,
    });
    const ticketId = goal.body.ticketId;
    await t1.app.agent.waitGoal(goal.body.id);

    // Trigger an event before restart
    t1.world.containers.emby = "exited";
    await vi.advanceTimersByTimeAsync(1000);

    await vi.waitFor(async () => {
      const res = await t1.call(`/v1/tickets/${ticketId}`);
      expect(res.body.inputs).toHaveLength(1);
    });
    const before = (await t1.call(`/v1/tickets/${ticketId}`)).body;
    expect(before.inputs).toHaveLength(1);

    // Re-open with same dir
    const t2 = setup({ agentStoreDir: dir });
    await vi.advanceTimersByTimeAsync(0);

    const after = (await t2.call(`/v1/tickets/${ticketId}`)).body;
    expect(after.subscriptions).toContain("resource:container:emby");
    expect(after.inputs).toHaveLength(1);
    expect(after.inputs[0].triggerId).toBe(before.inputs[0].triggerId);
  });
});
