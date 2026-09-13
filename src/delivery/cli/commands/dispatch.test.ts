import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createThebeAgent } from "../../../agent/index.ts";
import { createFakeRuntime } from "../../../testing/runtime/index.ts";
import { runCliCommand } from "./dispatch.ts";
import type { ContainerInfoProvider } from "../../../agent/capabilities/containers.ts";

const provider: ContainerInfoProvider = {
  async listContainers() {
    return [];
  },
  async inspectContainer() {
    throw new Error("unused");
  },
  async getContainerLogs() {
    throw new Error("unused");
  },
  async getStatusSummary() {
    return {
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 0,
    };
  },
};

describe("runCliCommand", () => {
  it("does not create a session when opening an empty TUI", async () => {
    const fake = createFakeRuntime();
    const dir = await mkdtemp(join(tmpdir(), "thebe-cli-empty-tui-"));
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider,
      agentStoreDir: dir,
    });
    let openedSessionId: string | undefined;

    await runCliCommand(
      agent,
      { kind: "tui", continueLast: false },
      {
        startTui: ({ sessionId }) => {
          openedSessionId = sessionId;
        },
      },
    );

    expect(openedSessionId).toBeUndefined();
    expect(await agent.listSessions()).toHaveLength(0);
  });

  it("creates, lists, prompts, exports through agent", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const dir = await mkdtemp(join(tmpdir(), "thebe-cli-"));
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider,
      agentStoreDir: dir,
    });
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    expect(
      await runCliCommand(
        agent,
        { kind: "session-create", title: "demo" },
        { log },
      ),
    ).toBe(0);
    const id = lines.at(-1)!;
    expect(id.length).toBeGreaterThan(8);

    lines.length = 0;
    expect(await runCliCommand(agent, { kind: "session-list" }, { log })).toBe(
      0,
    );
    expect(lines.some((line) => line.includes(id))).toBe(true);

    lines.length = 0;
    expect(
      await runCliCommand(
        agent,
        { kind: "print", text: "ping", sessionId: id },
        { log },
      ),
    ).toBe(0);
    expect(lines.at(-1)).toBe("pong");

    const out = join(dir, "export-out");
    lines.length = 0;
    expect(
      await runCliCommand(
        agent,
        {
          kind: "session-export",
          sessionId: id,
          format: "jsonl",
          out,
        },
        { log },
      ),
    ).toBe(0);
    const jsonl = await readFile(`${out}.jsonl`, "utf8");
    expect(jsonl.length).toBeGreaterThan(0);
  });

  it("compacts and forks", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "one" }]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    await runCliCommand(agent, { kind: "session-create" }, { log });
    const id = lines.at(-1)!;
    await runCliCommand(
      agent,
      { kind: "print", text: "hi", sessionId: id },
      { log },
    );
    expect(
      await runCliCommand(
        agent,
        { kind: "session-compact", sessionId: id },
        { log },
      ),
    ).toBe(0);
    lines.length = 0;
    expect(
      await runCliCommand(agent, { kind: "session-fork", sessionId: id }, { log }),
    ).toBe(0);
    expect(lines.at(-1)).not.toBe(id);
    expect(fake.compactCalls()).toBe(1);
  });
});
