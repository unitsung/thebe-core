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

  it("hydrates persisted messages before a resumed prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "thebe-dsh-transcript-"));
    const sessionRoot = join(root, "sessions");
    const firstRuntime = createDeepSeekHarnessRuntime({
      cwd: root,
      sessionRoot,
      harnessFactory: () => fakeHarness().harness,
    });
    const first = await firstRuntime.createSession({ customTools: [] });
    await first.prompt("remember this");
    first.dispose();

    const secondRuntime = createDeepSeekHarnessRuntime({
      cwd: root,
      sessionRoot,
      harnessFactory: () => fakeHarness().harness,
    });
    const resumed = await secondRuntime.resumeSession(first.runtimeSessionId, {
      customTools: [],
    });
    expect(resumed.messages()).toEqual([
      expect.objectContaining({ role: "user", text: "remember this" }),
      expect.objectContaining({ role: "assistant", text: "DSH replied." }),
    ]);
    expect(resumed.lastAssistantText()).toBe("DSH replied.");
  });

  it("honors the model selected when creating a runtime session", async () => {
    const root = await mkdtemp(join(tmpdir(), "thebe-dsh-model-"));
    const harnessModels: string[] = [];
    const runtime = createDeepSeekHarnessRuntime({
      cwd: root,
      sessionRoot: join(root, "sessions"),
      harnessFactory: (input) => {
        harnessModels.push(input.model);
        return fakeHarness().harness;
      },
    });
    const session = await runtime.createSession({
      customTools: [],
      model: {
        providerId: "deepseek-official",
        modelId: "deepseek-v4-pro",
      },
    });

    expect(session.currentModel?.()).toEqual({
      providerId: "deepseek-official",
      modelId: "deepseek-v4-pro",
    });
    await session.prompt("use the selected model");
    expect(harnessModels).toEqual(["deepseek-v4-pro"]);
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

  it("registers session-specific custom tools on the internal bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "thebe-dsh-session-tools-"));
    const fake = fakeHarness();
    let patchPath: string | undefined;
    let environment: NodeJS.ProcessEnv | undefined;
    let registered:
      | {
          tools: string[];
          permissionHandler?: PermissionHandler;
        }
      | undefined;
    const runtime = createDeepSeekHarnessRuntime({
      cwd: root,
      sessionRoot: join(root, "sessions"),
      harnessFactory: (input) => {
        patchPath = input.patches?.[0];
        environment = input.env;
        return fake.harness;
      },
    });
    const permissionHandler: PermissionHandler = {
      request: async () => "allow",
    };
    runtime.mountCoreMcp({
      token: "private-token",
      registerSession: (sessionId, binding) => {
        registered = {
          tools: binding.customTools.map((tool) => tool.name),
          ...(binding.permissionHandler
            ? { permissionHandler: binding.permissionHandler }
            : {}),
        };
        return {
          url: `http://127.0.0.1:8787/sessions/${sessionId}/mcp`,
        };
      },
    });
    const session = await runtime.createSession({
      builtinTools: [],
      permissionHandler,
      customTools: [
        {
          name: "goal_report",
          label: "Goal report",
          description: "Report the checkpoint",
          parameters: { type: "object" },
          execute: async () => ({
            content: [{ type: "text", text: "reported" }],
          }),
        },
      ],
    });
    await session.prompt("work");

    expect(registered).toMatchObject({
      tools: ["goal_report"],
      permissionHandler,
    });
    const patch = patchPath!;
    const contents = await readFile(patch, "utf8");
    expect(contents).toContain("thebe-session-tools");
    expect(contents).toContain("- id: tool-bash");
    expect(contents).toContain("  disabled: true");
    expect(contents).toContain(
      ["$", "{credential:CORE_MCP_BRIDGE_TOKEN}"].join("")
    );
    expect(contents).not.toContain("private-token");
    expect(environment?.CORE_MCP_BRIDGE_TOKEN).toBe("private-token");
    expect((await stat(patch)).mode & 0o777).toBe(0o600);
  });
});
