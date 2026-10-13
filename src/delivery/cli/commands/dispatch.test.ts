import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createThebeAgent } from "../../../agent/index.ts";
import { createFakeRuntime } from "../../../testing/runtime/index.ts";
import { runCliCommand } from "./dispatch.ts";
import type {
  McpRegistry,
  McpServerInfo,
} from "../../../agent/extensions/mcp.ts";
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
  it("uses the operator-configured model when creating a session", async () => {
    const fake = createFakeRuntime();
    const runtime = {
      ...fake.runtime,
      createSession: async (
        options: Parameters<typeof fake.runtime.createSession>[0]
      ) => {
        if (
          options.model?.providerId !== "fake" ||
          options.model?.modelId !== "fake-2"
        ) {
          throw new Error("Only the operator-configured model is available");
        }
        return fake.runtime.createSession(options);
      },
    };
    const agent = createThebeAgent({
      runtime,
      provider,
      model: { providerId: "fake", modelId: "fake-2" },
    });
    const lines: string[] = [];
    expect(
      await runCliCommand(
        agent,
        { kind: "session-create" },
        { log: (line) => lines.push(line) }
      )
    ).toBe(0);
    expect((await agent.getSession(lines.at(-1)!)).thebeSessionId).toBe(
      lines.at(-1)
    );
  });
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
      }
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
        { log }
      )
    ).toBe(0);
    const id = lines.at(-1)!;
    expect(id.length).toBeGreaterThan(8);

    lines.length = 0;
    expect(await runCliCommand(agent, { kind: "session-list" }, { log })).toBe(
      0
    );
    expect(lines.some((line) => line.includes(id))).toBe(true);

    lines.length = 0;
    expect(
      await runCliCommand(
        agent,
        { kind: "print", text: "ping", sessionId: id },
        { log }
      )
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
        { log }
      )
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
      { log }
    );
    expect(
      await runCliCommand(
        agent,
        { kind: "session-compact", sessionId: id },
        { log }
      )
    ).toBe(0);
    lines.length = 0;
    expect(
      await runCliCommand(
        agent,
        { kind: "session-fork", sessionId: id },
        { log }
      )
    ).toBe(0);
    expect(lines.at(-1)).not.toBe(id);
    expect(fake.compactCalls()).toBe(1);
  });

  it("registers, lists, enables, and removes an MCP server from the terminal", async () => {
    const agent = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider,
      mcp: fakeMcpRegistry(),
    });
    const lines: string[] = [];
    const errors: string[] = [];
    const log = (line: string) => lines.push(line);
    const error = (line: string) => errors.push(line);

    expect(
      await runCliCommand(
        agent,
        {
          kind: "mcp-add",
          name: "music",
          url: "http://127.0.0.1:8099/mcp",
          args: [],
          env: {},
          headers: { sqmusic: "jwt" },
        },
        { log, error }
      )
    ).toBe(0);
    expect(lines.join("\n")).toContain("added music");
    expect(lines.join("\n")).toContain("disabled");

    lines.length = 0;
    expect(
      await runCliCommand(agent, { kind: "mcp-list" }, { log, error })
    ).toBe(0);
    expect(lines.join("\n")).toContain(
      "music\tdisabled\thttp://127.0.0.1:8099/mcp"
    );

    lines.length = 0;
    expect(
      await runCliCommand(
        agent,
        { kind: "mcp-enable", name: "music" },
        { log, error }
      )
    ).toBe(0);
    expect(lines.join("\n")).toContain("music enabled");
    lines.length = 0;
    expect(
      await runCliCommand(agent, { kind: "mcp-list" }, { log, error })
    ).toBe(0);
    expect(lines.join("\n")).toContain("music\tenabled");

    lines.length = 0;
    expect(
      await runCliCommand(
        agent,
        { kind: "mcp-remove", name: "music" },
        { log, error }
      )
    ).toBe(0);
    expect(lines.join("\n")).toContain("removed music");
    lines.length = 0;
    expect(
      await runCliCommand(agent, { kind: "mcp-list" }, { log, error })
    ).toBe(0);
    expect(lines.join("\n")).toContain("(no MCP servers)");

    expect(
      await runCliCommand(
        agent,
        { kind: "mcp-enable", name: "ghost" },
        { log, error }
      )
    ).toBe(1);
    expect(errors.join("\n")).toContain("unknown MCP server");
  });
});

/** In-memory registry so this delivery test never imports a concrete adapter. */
function fakeMcpRegistry(): McpRegistry {
  const servers = new Map<string, McpServerInfo>();
  return {
    async addServer(input) {
      const info: McpServerInfo = {
        name: input.name,
        url: input.url,
        command: input.command,
        status: "disabled",
        disabled: true,
      };
      servers.set(input.name, info);
      return info;
    },
    async listServers() {
      return [...servers.values()];
    },
    async setServerEnabled(name, enabled) {
      const found = servers.get(name);
      if (!found) return undefined;
      const updated: McpServerInfo = {
        ...found,
        disabled: !enabled,
        status: enabled ? "configured" : "disabled",
      };
      servers.set(name, updated);
      return updated;
    },
    async removeServer(name) {
      return servers.delete(name);
    },
    async listTools() {
      return [];
    },
    async invokeTool() {
      return undefined;
    },
    close() {},
  };
}
