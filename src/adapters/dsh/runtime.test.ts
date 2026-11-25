import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PermissionHandler } from "../../agent/runtime/interface.ts";
import {
  createDeepSeekHarnessRuntime,
  type DshHarnessLike,
} from "./runtime.ts";

function fakeHarness(options: { resume?: boolean } = {}) {
  let requestHandler:
    | ((method: string, params: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  const runs: unknown[] = [];
  const resumes: string[] = [];
  const closes = vi.fn(async () => {});
  const harness: DshHarnessLike = {
    client: {
      onRequest(handler) {
        requestHandler = handler;
      },
      async prompt() {
        return "queued";
      },
    },
    async start() {},
    session(id) {
      return {
        id,
        async run(input, runOptions) {
          runs.push(input);
          runOptions?.onNotification?.({
            method: "session.event",
            params: {
              sessionId: id,
              event: {
                seq: 1,
                time: Date.now(),
                type: "assistant/message",
                data: {
                  message: {
                    id: "assistant-1",
                    role: "assistant",
                    content: [{ type: "text", text: "DSH replied." }],
                  },
                },
              },
            },
          });
          return {
            sessionId: id,
            events: [
              {
                seq: 2,
                time: Date.now(),
                type: "turn/end",
                data: { reason: { kind: "completed" } },
              },
            ],
          };
        },
      };
    },
    async resumeSession(sessionId) {
      resumes.push(sessionId);
      return harness.session(sessionId);
    },
    close: closes,
  };
  if (options.resume) {
    // The fake's resume path is exercised through the public runtime method.
  }
  return {
    harness,
    runs,
    resumes,
    closes,
    request: async (method: string, params: Record<string, unknown>) => {
      if (!requestHandler) throw new Error("request handler not installed");
      return requestHandler(method, params);
    },
  };
}

describe("DeepSeek Harness AgentRuntime", () => {
  it("creates a session, streams normalized events, and records messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "thebe-dsh-runtime-"));
    const fake = fakeHarness();
    const runtime = createDeepSeekHarnessRuntime({
      cwd: root,
      sessionRoot: join(root, "sessions"),
      harnessFactory: () => fake.harness,
    });
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: [],
    });
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));

    await session.prompt("hello");

    expect(runtime.runtimeId).toBe("deepseek-harness");
    expect(fake.runs).toEqual([[{ type: "text", text: "hello" }]]);
    expect(events).toEqual(["text_delta", "turn_end"]);
    expect(session.lastAssistantText()).toBe("DSH replied.");
    expect(session.messages()).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
      expect.objectContaining({ role: "assistant", text: "DSH replied." }),
    ]);
    session.dispose();
    expect(fake.closes).toHaveBeenCalledOnce();
  });

  it("resumes the persisted DSH session before its first prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "thebe-dsh-resume-"));
    const fake = fakeHarness();
    const runtime = createDeepSeekHarnessRuntime({
      cwd: root,
      sessionRoot: join(root, "sessions"),
      harnessFactory: () => fake.harness,
    });
    const session = await runtime.resumeSession("session-existing", {
      customTools: [],
    });
    expect(fake.resumes).toEqual([]);
    await session.prompt("continue");
    expect(fake.resumes).toEqual(["session-existing"]);
  });

  it("routes DSH approval requests through the Core permission handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "thebe-dsh-approval-"));
    const fake = fakeHarness();
    const runtime = createDeepSeekHarnessRuntime({
      cwd: root,
      sessionRoot: join(root, "sessions"),
      harnessFactory: () => fake.harness,
    });
    const permissionHandler: PermissionHandler = {
      request: vi.fn(async () => "allow" as const),
    };
    const session = await runtime.createSession({
      customTools: [],
      permissionHandler,
    });
    await session.prompt("start");

    await expect(
      fake.request("approval/request", {
        sessionId: "session-1",
        toolName: "bash",
        callId: "call-1",
        reason: "run a command",
      })
    ).resolves.toEqual({ outcome: "allowed-once" });
    expect(permissionHandler.request).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "bash",
        toolCallId: "call-1",
        argsSummary: "run a command",
      })
    );
  });

  it("reports unsupported session operations instead of silently faking them", async () => {
    const root = await mkdtemp(join(tmpdir(), "thebe-dsh-unsupported-"));
    const runtime = createDeepSeekHarnessRuntime({
      cwd: root,
      sessionRoot: join(root, "sessions"),
      harnessFactory: () => fakeHarness().harness,
    });
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: [],
    });
    await expect(session.revert()).rejects.toThrow(
      /DeepSeek Harness runtime does not support revert/
    );
    await expect(
      runtime.forkSession("session-1", { customTools: [] })
    ).rejects.toThrow(/does not support fork/);
  });

  it("mounts the live Core MCP surface through a private DSH patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "thebe-dsh-mcp-"));
    const fake = fakeHarness();
    let patches: string[] | undefined;
    let environment: NodeJS.ProcessEnv | undefined;
    const runtime = createDeepSeekHarnessRuntime({
      cwd: root,
      sessionRoot: join(root, "sessions"),
      harnessFactory: (input) => {
        patches = input.patches;
        environment = input.env;
        return fake.harness;
      },
    });
    runtime.mountCoreMcp({
      url: "http://127.0.0.1:8787/mcp",
      token: "private-token",
    });
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: [],
    });
    await session.prompt("use tools");

    expect(patches).toHaveLength(1);
    const patch = patches![0]!;
    const contents = await readFile(patch, "utf8");
    expect(contents).toContain("@deepseek-ai/dsh-mcp-client");
    expect(contents).toContain("- id: tool-bash");
    expect(contents).toContain("  disabled: true");
    expect(contents).toContain("http://127.0.0.1:8787/mcp");
    expect(contents).toContain(
      ["$", "{credential:CORE_MCP_BRIDGE_TOKEN}"].join("")
    );
    expect(contents).not.toContain("private-token");
    expect(environment?.CORE_MCP_BRIDGE_TOKEN).toBe("private-token");
    expect((await stat(patch)).mode & 0o777).toBe(0o600);
  });
});
