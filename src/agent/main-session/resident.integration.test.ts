import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerInfoProvider,
  ContainerState,
} from "../capabilities/containers.ts";
import type { AgentRuntime } from "../runtime/interface.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createThebeAgent } from "../create.ts";

type World = Record<string, ContainerState>;
type HarnessState = {
  dir: string;
  fake: ReturnType<typeof createFakeRuntime>;
  world: World;
  prompts: string[];
};

function provider(world: World): ContainerInfoProvider {
  return {
    async listContainers() {
      return Object.entries(world).map(([name, state]) => ({
        id: `id-${name}`,
        name,
        image: `image/${name}`,
        state,
        status: state,
        created: 1,
      }));
    },
    async inspectContainer() {
      throw new Error("unused");
    },
    async getContainerLogs() {
      return "";
    },
    async getStatusSummary() {
      const states = Object.values(world);
      return {
        totalContainers: states.length,
        runningContainers: states.filter((state) => state === "running").length,
        pausedContainers: 0,
        exitedContainers: states.filter((state) => state === "exited").length,
        lastUpdated: 1,
      };
    },
  };
}

async function harness(
  dailyBackgroundTokenBudget?: number,
  existing?: HarnessState
) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const dir =
    existing?.dir ?? (await mkdtemp(join(tmpdir(), "thebe-resident-e2e-")));
  const fake = existing?.fake ?? createFakeRuntime();
  const prompts = existing?.prompts ?? [];
  function recordPrompts(
    session: Awaited<ReturnType<typeof fake.runtime.createSession>>,
    create: Parameters<AgentRuntime["createSession"]>[0]
  ) {
    return {
      ...session,
      async prompt(input: Parameters<typeof session.prompt>[0]) {
        const text = typeof input === "string" ? input : input.text;
        if (create.systemPrompt?.includes("# Thebe main Session")) {
          prompts.push(text);
        }
        return session.prompt(input);
      },
    };
  }
  const runtime: AgentRuntime = {
    ...fake.runtime,
    async createSession(create) {
      const session = await fake.runtime.createSession(create);
      return recordPrompts(session, create);
    },
    async resumeSession(runtimeSessionId, create) {
      const session = await fake.runtime.resumeSession(
        runtimeSessionId,
        create
      );
      return recordPrompts(session, create);
    },
  };
  const world: World = existing?.world ?? {
    emby: "running",
    sonarr: "running",
  };
  const agent = createThebeAgent({
    runtime,
    provider: provider(world),
    agentStoreDir: dir,
    sources: { containerHealth: true, intervalMs: 1_000 },
    permissionMode: "bypassPermissions",
    dailyBackgroundTokenBudget,
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => {
    expect(agent.sourceHealth?.()[0]?.state).toBe("healthy");
  });
  return {
    agent,
    fake,
    prompts,
    world,
    state: { dir, fake, world, prompts },
    backgroundPrompts() {
      return prompts.filter((prompt) =>
        prompt.startsWith("# Main Session background batch")
      );
    },
  };
}

async function initializeMainSession(
  fake: ReturnType<typeof createFakeRuntime>,
  agent: ReturnType<typeof createThebeAgent>
): Promise<void> {
  fake.queueTurns([{ kind: "text", text: "Thebe is ready." }]);
  await agent.askMainSession("Hello");
}

async function emitContainerChanges(
  world: World,
  names: readonly string[]
): Promise<void> {
  for (const name of names) world[name] = "exited";
  await vi.advanceTimersByTimeAsync(1_000);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resident main Session integration", () => {
  it("merges one Source batch into one Main Session turn", async () => {
    const state = await harness();
    try {
      await initializeMainSession(state.fake, state.agent);
      state.fake.queueTurns([{ kind: "text", text: "Reviewed both events." }]);

      await emitContainerChanges(state.world, ["emby", "sonarr"]);
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => {
        expect(state.backgroundPrompts()).toHaveLength(1);
      });

      expect(state.backgroundPrompts()[0]).toContain("resource:container:emby");
      expect(state.backgroundPrompts()[0]).toContain(
        "resource:container:sonarr"
      );
      expect(
        (await state.agent.getBackgroundBudgetSummary()).usage.counted
      ).toBeGreaterThan(0);
    } finally {
      await state.agent.quiesce();
    }
  });

  it("keeps personal chat available while spent, then resumes resident work when restored", async () => {
    const state = await harness(0);
    try {
      await initializeMainSession(state.fake, state.agent);
      await emitContainerChanges(state.world, ["emby"]);
      await vi.advanceTimersByTimeAsync(100);
      expect(state.backgroundPrompts()).toEqual([]);

      await state.agent.setDailyBackgroundTokenBudget(1_000_000);
      state.fake.queueTurns([
        { kind: "text", text: "Your chat still works." },
        { kind: "text", text: "Background work resumed." },
      ]);
      await state.agent.askMainSession("Are you there?");
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => {
        expect(state.backgroundPrompts()).toHaveLength(1);
      });
    } finally {
      await state.agent.quiesce();
    }
  });

  it("routes a recovered event through the main Session tool set", async () => {
    const state = await harness();
    try {
      await initializeMainSession(state.fake, state.agent);
      state.fake.queueTurns([{ kind: "hang" }]);
      const ticket = await state.agent.delegateTicket({
        task: "Watch the media server",
        idempotencyKey: "resident-attach",
      });
      await vi.waitFor(async () => {
        expect(
          (await state.agent.listSubagents()).some(
            (run) => run.status === "running"
          )
        ).toBe(true);
      });

      await state.agent.setDailyBackgroundTokenBudget(0);
      await emitContainerChanges(state.world, ["emby"]);
      await vi.waitFor(async () => {
        expect(
          await state.agent.listDecisions({
            thread: "resource:container:emby",
          })
        ).toHaveLength(1);
      });
      const decision = (
        await state.agent.listDecisions({ thread: "resource:container:emby" })
      )[0]!;

      state.fake.queueTurns([
        { kind: "text", text: "Ready." },
        {
          kind: "tools",
          calls: [
            {
              name: "decision_attach",
              args: {
                decisionId: decision.id,
                ticketId: ticket.ticket.id,
                note: "The same media-server recovery.",
              },
            },
          ],
        },
        { kind: "text", text: "Attached the event to the existing Ticket." },
      ]);
      await state.agent.setDailyBackgroundTokenBudget(1_000_000);
      await state.agent.askMainSession("Continue.");
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(async () => {
        const current = await state.agent.getTicket(ticket.ticket.id);
        expect(
          current?.inputs.some(
            (input) => input.triggerId === decision.triggerIds[0]
          )
        ).toBe(true);
      });
      expect(
        state.fake
          .inboundToolResults()
          .some(
            (result) => result.toolName === "decision_attach" && !result.isError
          )
      ).toBe(true);
    } finally {
      await state.agent.quiesce();
    }
  });

  it("recovers a pending Source event once after Core recreation", async () => {
    const first = await harness();
    let second: Awaited<ReturnType<typeof harness>> | undefined;
    let third: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      await initializeMainSession(first.fake, first.agent);
      await first.agent.setDailyBackgroundTokenBudget(0);
      await emitContainerChanges(first.world, ["emby"]);
      await vi.waitFor(async () => {
        expect(
          await first.agent.listDecisions({
            thread: "resource:container:emby",
          })
        ).toHaveLength(1);
      });

      await first.agent.quiesce();
      await first.fake.runtime.unquiesce();
      first.fake.queueTurns([
        { kind: "text", text: "Thebe is back." },
        { kind: "text", text: "Recovered the event." },
      ]);
      second = await harness(undefined, first.state);
      await second.agent.setDailyBackgroundTokenBudget(1_000_000);
      await second.agent.askMainSession("Continue after restart.");
      await vi.waitFor(() => {
        expect(first.backgroundPrompts()).toHaveLength(1);
      });
      expect(first.backgroundPrompts()[0]).toContain("resource:container:emby");

      await second.agent.quiesce();
      await first.fake.runtime.unquiesce();
      third = await harness(undefined, first.state);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(first.backgroundPrompts()).toHaveLength(1);
    } finally {
      await third?.agent.quiesce();
      await second?.agent.quiesce();
      await first.agent.quiesce();
    }
  });
});
