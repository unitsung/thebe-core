import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "./capabilities/containers.ts";
import { createFakeRuntime } from "../testing/runtime/index.ts";
import { createThebeAgent } from "./index.ts";

const provider: ContainerInfoProvider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => {
    throw new Error("unused");
  },
  getStatusSummary: async () => {
    throw new Error("unused");
  },
};

describe("prompt result events", () => {
  it("only carry the events of the session that was prompted", async () => {
    const fake = createFakeRuntime();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let gatedRuntimeSession: string | undefined;
    const agent = createThebeAgent({
      runtime: {
        ...fake.runtime,
        async createSession(options) {
          const session = await fake.runtime.createSession(options);
          return {
            ...session,
            async prompt(input) {
              if (session.runtimeSessionId === gatedRuntimeSession) await gate;
              return session.prompt(input);
            },
          };
        },
      },
      provider,
    });
    const a = await agent.createSession({ title: "A" });
    const b = await agent.createSession({ title: "B" });
    gatedRuntimeSession = b.runtimeSessionId;

    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const pending = agent.prompt("hello", { thebeSessionId: b.thebeSessionId });
    // While B is mid-run, A produces an event of its own.
    await agent.interrupt(a.thebeSessionId);
    release();
    const result = await pending;

    expect(result.events.some((event) => event.type === "interrupted")).toBe(false);
    expect(result.events.length).toBeGreaterThan(0);
  });
});
