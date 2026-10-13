import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createThebeAgent } from "../../../agent/index.ts";
import type { ContainerInfoProvider } from "../../../agent/capabilities/containers.ts";
import { PI_RUNTIME_ID } from "../../../agent/runtime/interface.ts";
import { isSeatbeltAvailable } from "../../../agent/security/command-sandbox.ts";
import { loadPiSdk } from "../sdk/load-pi.ts";
import { createPiCodingAgentRuntime } from "../runtime.ts";

function emptyProvider(): ContainerInfoProvider {
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

function gondolinMicroVmAvailable(): boolean {
  try {
    require.resolve("@earendil-works/gondolin");
  } catch {
    return false;
  }
  // Needs a backend that can actually boot, not just the package: QEMU plus
  // hardware virtualization (HVF on macOS, KVM on Linux). Shared CI runners
  // have neither, so the integration test skips instead of hanging.
  const qemu = ["qemu-system-x86_64", "qemu-system-aarch64"].some(
    (bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0
  );
  if (!qemu) return false;
  return process.platform === "darwin" || existsSync("/dev/kvm");
}

async function piWithFaux(sessionDir?: string) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const { ModelRuntime } = await loadPiSdk();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.getModel().provider, "test-key");
  const runtime = await createPiCodingAgentRuntime({
    cwd: process.cwd(),
    sessionDir,
    inMemory: !sessionDir,
    modelRuntime,
    model: faux.getModel(),
    agentDir: sessionDir ? join(sessionDir, "agent") : undefined,
  });
  return { faux, runtime, modelRuntime };
}

/** A stdio MCP server speaking the wire protocol directly, with a read-only and a write tool. */
function mcpFixture(
  initial: {
    block?: string;
    enabled?: boolean;
    exposure?: "codemode" | "deferred";
  } = {}
) {
  const script = [
    "const fs = require('node:fs');",
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  const m = JSON.parse(line);",
    "  if (m.id === undefined) return;",
    "  let result = {};",
    "  if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };",
    "  if (m.method === 'tools/list') result = { tools: [",
    "    { name: 'catalog', description: 'Search remote catalog', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },",
    "    { name: 'publish', description: 'Publish playlist', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },",
    "    { name: 'leak', description: 'Return a secret leak', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },",
    "    { name: 'env', description: 'Report environment', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },",
    "  ] };",
    "  if (m.method === 'tools/call') {",
    "    fs.appendFileSync(process.env.CALL_LOG, m.params.name + '\\n');",
    "    const text = m.params.name === 'leak' ? 'key sk-live-abcdefghijklmnopqrstuvwxyz'",
    "      : m.params.name === 'env' ? 'env-checked ' + (process.env.THEBE_TEST_SECRET || 'absent') + ' ' + (process.env.SERVER_ONLY || '')",
    "      : 'remote:' + ((m.params.arguments || {}).query || '');",
    "    result = { content: [{ type: 'text', text }] };",
    "  }",
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');",
    "});",
  ].join("\n");
  const log = join(
    mkdtempSync(join(tmpdir(), "thebe-mcp-calls-")),
    "calls.log"
  );
  writeFileSync(log, "");
  let enabled = initial.enabled ?? true;
  const before: Array<{ toolName: string }> = [];
  const after: Array<{
    toolName: string;
    isError: boolean;
    redacted: boolean;
  }> = [];
  const options = {
    servers: () => [
      {
        name: "fixture",
        command: process.execPath,
        args: ["-e", script],
        enabled,
        exposure: initial.exposure ?? "deferred",
        env: { CALL_LOG: log, SERVER_ONLY: "server-only" },
      },
    ],
    async beforeCall(call: { toolName: string }) {
      before.push(call);
      return initial.block ? { block: initial.block } : undefined;
    },
    async afterCall(
      call: { toolName: string },
      outcome: { isError: boolean; redacted: boolean }
    ) {
      after.push({ toolName: call.toolName, ...outcome });
    },
  };
  return {
    options,
    before,
    after,
    setEnabled(value: boolean) {
      enabled = value;
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
  };
}

describe("PiCodingAgentRuntime sessions", () => {
  it("connects MCP servers through the runtime's own client and loads schemas only after discovery", async () => {
    const { faux, runtime } = await piWithFaux();
    const mcp = mcpFixture();
    const schemas: string[][] = [];
    faux.setResponses([
      (context) => {
        schemas.push(
          getCurrentTools(context.messages).map((tool) => tool.name)
        );
        return fauxAssistantMessage([
          fauxToolCall("tool_search", { query: "remote catalog", limit: 1 }),
        ]);
      },
      (context) => {
        schemas.push(
          getCurrentTools(context.messages).map((tool) => tool.name)
        );
        return fauxAssistantMessage([
          fauxToolCall("mcp__fixture__catalog", { query: "music" }),
        ]);
      },
      fauxAssistantMessage("done"),
    ]);
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: ["read"],
      mcp: mcp.options,
    });
    try {
      await session.prompt("search remote catalog");
      expect(schemas[0]).toEqual(
        expect.arrayContaining(["read", "tool_search"])
      );
      expect(schemas[0]).not.toContain("mcp__fixture__catalog");
      expect(schemas[1]).toContain("mcp__fixture__catalog");
      expect(session.messages()).toContainEqual(
        expect.objectContaining({
          role: "tool",
          toolName: "mcp__fixture__catalog",
          text: expect.stringContaining("remote:music"),
        })
      );
      expect(mcp.before.map((call) => call.toolName)).toEqual([
        "mcp__fixture__catalog",
      ]);
      expect(mcp.after).toEqual([
        expect.objectContaining({
          toolName: "mcp__fixture__catalog",
          isError: false,
        }),
      ]);
    } finally {
      session.dispose();
    }
  });

  it("redacts MCP results and fences them as untrusted output", async () => {
    const { faux, runtime } = await piWithFaux();
    const mcp = mcpFixture();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("tool_search", { query: "secret leak", limit: 1 }),
      ]),
      fauxAssistantMessage([fauxToolCall("mcp__fixture__leak", {})]),
      fauxAssistantMessage("done"),
    ]);
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: ["read"],
      mcp: mcp.options,
    });
    try {
      await session.prompt("leak");
      const text = JSON.stringify(session.messages());
      expect(text).toContain('<tool_output tool=\\"mcp__fixture__leak\\">');
      expect(text).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz");
      expect(mcp.after[0]).toMatchObject({ redacted: true });
    } finally {
      session.dispose();
    }
  });

  it("blocks a policy-denied MCP call before it reaches the server", async () => {
    const { faux, runtime } = await piWithFaux();
    const mcp = mcpFixture({ block: "budget exhausted" });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("tool_search", { query: "remote catalog", limit: 1 }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("mcp__fixture__catalog", { query: "music" }),
      ]),
      fauxAssistantMessage("blocked"),
    ]);
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: ["read"],
      mcp: mcp.options,
    });
    try {
      await session.prompt("search");
      expect(JSON.stringify(session.messages())).toContain("budget exhausted");
      expect(JSON.stringify(session.messages())).not.toContain("remote:music");
      expect(mcp.after).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it("asks before a server's write tool runs and does not run it when denied", async () => {
    const { faux, runtime } = await piWithFaux();
    const mcp = mcpFixture();
    const request = vi.fn(async () => "deny" as const);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("tool_search", { query: "publish playlist", limit: 1 }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("mcp__fixture__publish", { id: "playlist-1" }),
      ]),
      fauxAssistantMessage("denied"),
    ]);
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: ["read"],
      permissionHandler: { request },
      mcp: mcp.options,
    });
    try {
      await session.prompt("publish");
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "mcp__fixture__publish",
          risk: "high",
        })
      );
      expect(mcp.calls()).not.toContain("publish");
    } finally {
      session.dispose();
    }
  });

  it("does not ask for a tool the server marks read-only", async () => {
    const { faux, runtime } = await piWithFaux();
    const mcp = mcpFixture();
    const request = vi.fn(async () => "deny" as const);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("tool_search", { query: "remote catalog", limit: 1 }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("mcp__fixture__catalog", { query: "music" }),
      ]),
      fauxAssistantMessage("done"),
    ]);
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: ["read"],
      permissionHandler: { request },
      mcp: mcp.options,
    });
    try {
      await session.prompt("search");
      expect(request).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it("refreshes MCP servers in an existing session after enable and disable", async () => {
    const { faux, runtime } = await piWithFaux();
    const mcp = mcpFixture({ enabled: false });
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: ["read"],
      mcp: mcp.options,
    });
    try {
      faux.setResponses([fauxAssistantMessage("no MCP enabled")]);
      await session.prompt("list available tools");
      expect(session.toolNames()).not.toContain("mcp__fixture__catalog");
      mcp.setEnabled(true);
      await session.reloadResources!();
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("tool_search", { query: "remote catalog", limit: 1 }),
        ]),
        fauxAssistantMessage([
          fauxToolCall("mcp__fixture__catalog", { query: "x" }),
        ]),
        fauxAssistantMessage("enabled"),
      ]);
      await session.prompt("search");
      expect(mcp.calls()).toContain("catalog");
      mcp.setEnabled(false);
      await session.reloadResources!();
      expect(session.toolNames()).not.toContain("mcp__fixture__catalog");
    } finally {
      session.dispose();
    }
  });

  it("keeps approval, policy and redaction on calls a codemode script makes", async () => {
    const { faux, runtime } = await piWithFaux();
    const mcp = mcpFixture({ exposure: "codemode" });
    const request = vi.fn(async () => "deny" as const);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("codemode", {
          code: "const r = await tools.mcp__fixture__leak({}); text(JSON.stringify(r)); try { await tools.mcp__fixture__publish({ id: 'p' }); } catch (e) { text('publish failed: ' + e.message); }",
        }),
      ]),
      fauxAssistantMessage("done"),
    ]);
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: ["read"],
      permissionHandler: { request },
      mcp: mcp.options,
    });
    try {
      await session.prompt("script");
      const text = JSON.stringify(session.messages());
      expect(text).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz");
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "mcp__fixture__publish" })
      );
      expect(mcp.calls()).toEqual(["leak"]);
      expect(mcp.before.map((call) => call.toolName)).toEqual([
        "mcp__fixture__leak",
        "mcp__fixture__publish",
      ]);
    } finally {
      session.dispose();
    }
  });

  it("starts stdio servers without Core's own environment", async () => {
    const { faux, runtime } = await piWithFaux();
    process.env.THEBE_TEST_SECRET = "must-not-reach-mcp";
    const mcp = mcpFixture();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("tool_search", { query: "environment", limit: 1 }),
      ]),
      fauxAssistantMessage([fauxToolCall("mcp__fixture__env", {})]),
      fauxAssistantMessage("done"),
    ]);
    const session = await runtime.createSession({
      customTools: [],
      builtinTools: ["read"],
      mcp: mcp.options,
    });
    try {
      await session.prompt("env");
      const text = JSON.stringify(session.messages());
      expect(text).toContain("env-checked");
      expect(text).not.toContain("must-not-reach-mcp");
      expect(text).toContain("server-only");
    } finally {
      delete process.env.THEBE_TEST_SECRET;
      session.dispose();
    }
  });
  it("rejects a terminal model failure and allows the next turn to recover", async () => {
    const { faux, runtime } = await piWithFaux();
    const agent = createThebeAgent({ runtime, provider: emptyProvider() });
    const session = await agent.createSession();
    const events: string[] = [];
    agent.subscribeLog(session.thebeSessionId, (event) =>
      events.push(event.type)
    );
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "FreeTierError: free tier requires the OpenCode client",
      }),
    ]);

    await expect(
      agent.prompt("hello", { thebeSessionId: session.thebeSessionId })
    ).rejects.toThrow("FreeTierError");
    expect(events.filter((type) => type === "error")).toHaveLength(1);
    expect(events).not.toContain("session_end");
    expect(await agent.loadMessages(session.thebeSessionId)).toContainEqual(
      expect.objectContaining({ role: "assistant", isError: true })
    );

    faux.setResponses([fauxAssistantMessage("recovered")]);
    await expect(
      agent.prompt("try again", { thebeSessionId: session.thebeSessionId })
    ).resolves.toMatchObject({ text: "recovered" });
    expect(events.filter((type) => type === "session_end")).toHaveLength(1);
  });

  it("tracks and stops detached bash background tasks", async () => {
    const { faux, runtime } = await piWithFaux();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall(
          "bash",
          { command: "sleep 60 >/dev/null 2>&1 &" },
          { id: "call_bg" }
        ),
      ]),
      fauxAssistantMessage("started"),
    ]);
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
      permissionMode: "full-access",
    });
    const session = await agent.createSession();

    await expect(
      agent.send("start a background task", session.thebeSessionId)
    ).resolves.toMatchObject({
      text: "started",
    });

    const tasks = await agent.listBackgroundTasks(session.thebeSessionId);
    expect(tasks).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        name: "sleep 60 >/dev/null 2>&1 &",
        pid: expect.any(Number),
        status: "running",
        startedAt: expect.any(String),
        updatedAt: expect.any(String),
      }),
    ]);

    await agent.stopBackgroundTask(session.thebeSessionId, tasks[0]!.id);
    await expect(
      agent.listBackgroundTasks(session.thebeSessionId)
    ).resolves.toEqual([
      expect.objectContaining({
        id: tasks[0]!.id,
        status: "stopped",
        finishedAt: expect.any(String),
      }),
    ]);
  });

  it("recovers detached bash background tasks after runtime recreation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-background-recovery-"));
    const first = await piWithFaux(dir);
    first.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall(
          "bash",
          { command: "sleep 60 >/dev/null 2>&1 &" },
          { id: "call_bg_recovery" }
        ),
      ]),
      fauxAssistantMessage("started"),
    ]);
    const firstAgent = createThebeAgent({
      runtime: first.runtime,
      provider: emptyProvider(),
      agentStoreDir: join(dir, "meta"),
      permissionMode: "full-access",
    });
    const session = await firstAgent.createSession();
    let taskId: string | undefined;
    try {
      await firstAgent.send("start a background task", session.thebeSessionId);
      const started = await firstAgent.listBackgroundTasks(
        session.thebeSessionId
      );
      taskId = started[0]?.id;
      expect(taskId).toEqual(expect.any(String));

      const second = await piWithFaux(dir);
      const resumed = createThebeAgent({
        runtime: second.runtime,
        provider: emptyProvider(),
        agentStoreDir: join(dir, "meta"),
        permissionMode: "full-access",
      });

      await expect(
        resumed.listBackgroundTasks(session.thebeSessionId)
      ).resolves.toEqual([
        expect.objectContaining({
          id: taskId,
          name: "sleep 60 >/dev/null 2>&1 &",
          status: "running",
          pid: expect.any(Number),
        }),
      ]);
      await resumed.stopBackgroundTask(session.thebeSessionId, taskId!);
    } finally {
      if (taskId)
        await firstAgent.stopBackgroundTask(session.thebeSessionId, taskId);
    }
  });

  it("tracks detached bash from the direct execution seam", async () => {
    const { runtime } = await piWithFaux();
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
    });
    const session = await agent.createSession();
    let taskId: string | undefined;
    try {
      await agent.executeBash(
        session.thebeSessionId,
        "sleep 60 >/dev/null 2>&1 &"
      );
      const tasks = await agent.listBackgroundTasks(session.thebeSessionId);
      taskId = tasks[0]?.id;
      expect(tasks).toEqual([
        expect.objectContaining({
          id: expect.any(String),
          name: "sleep 60 >/dev/null 2>&1 &",
          pid: expect.any(Number),
          status: "running",
        }),
      ]);
    } finally {
      if (taskId)
        await agent.stopBackgroundTask(session.thebeSessionId, taskId);
    }
  });

  it.skipIf(!gondolinMicroVmAvailable())(
    "routes bash through the Micro-VM backend when THEBE_SANDBOX=gondolin",
    async () => {
      const previous = process.env.THEBE_SANDBOX;
      process.env.THEBE_SANDBOX = "gondolin";
      try {
        const { faux, runtime } = await piWithFaux();
        faux.setResponses([
          fauxAssistantMessage([
            fauxToolCall("bash", { command: "uname -a" }, { id: "call_vm" }),
          ]),
          fauxAssistantMessage("done"),
        ]);
        const agent = createThebeAgent({
          runtime,
          provider: emptyProvider(),
          permissionMode: "full-access",
        });
        const session = await agent.createSession();

        // The command runs inside the guest instead of touching the host.
        await expect(
          agent.send("run uname in the vm", session.thebeSessionId)
        ).resolves.toMatchObject({ text: "done" });
        const transcript = JSON.stringify(
          await agent.loadMessages(session.thebeSessionId)
        );
        expect(transcript).toContain("Linux");
        expect(transcript).toContain('toolName":"bash');
      } finally {
        if (previous === undefined) delete process.env.THEBE_SANDBOX;
        else process.env.THEBE_SANDBOX = previous;
      }
    }
  );

  it.skipIf(!isSeatbeltAvailable())(
    "lifts the OS sandbox for a session under the full-access preset",
    async () => {
      const previousSandbox = process.env.THEBE_SANDBOX;
      process.env.THEBE_SANDBOX = "seatbelt";
      const workspace = await mkdtemp(
        join(tmpdir(), "thebe-full-access-sandbox-")
      );
      const target = join(
        process.cwd(),
        `.thebe-full-access-${randomUUID()}.txt`
      );
      try {
        const { faux, runtime } = await piWithFaux();
        faux.setResponses([
          fauxAssistantMessage([
            fauxToolCall(
              "bash",
              { command: `printf hi > ${target}` },
              { id: "c1" }
            ),
          ]),
          fauxAssistantMessage("done"),
        ]);
        const agent = createThebeAgent({
          runtime,
          provider: emptyProvider(),
          permissionMode: "full-access",
          fullAccessAllowed: true,
          workspacePath: workspace,
        });
        const session = await agent.createSession();

        // With the sandbox on, a write outside the workspace is refused.
        await agent.send("write outside", session.thebeSessionId);
        expect(existsSync(target)).toBe(false);

        // Enabling the preset takes effect on the next command, in place.
        await agent.setSessionFullAccess(session.thebeSessionId, true);
        faux.setResponses([
          fauxAssistantMessage([
            fauxToolCall(
              "bash",
              { command: `printf hi > ${target}` },
              { id: "c2" }
            ),
          ]),
          fauxAssistantMessage("done"),
        ]);
        await agent.send("write outside again", session.thebeSessionId);
        expect(existsSync(target)).toBe(true);
      } finally {
        await rm(target, { force: true });
        if (previousSandbox === undefined) delete process.env.THEBE_SANDBOX;
        else process.env.THEBE_SANDBOX = previousSandbox;
      }
    }
  );

  it("exposes Pi native content and filename search without bash", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "thebe-pi-search-tools-"));
    await writeFile(
      join(workspace, "needle.txt"),
      "needle in workspace\n",
      "utf8"
    );
    const { faux, runtime } = await piWithFaux();
    let modelToolNames: string[] | undefined;
    faux.setResponses([
      (context) => {
        modelToolNames = getCurrentTools(context.messages).map(
          (tool) => tool.name
        );
        return fauxAssistantMessage([
          fauxToolCall("grep", { pattern: "needle" }, { id: "call_grep" }),
        ]);
      },
      fauxAssistantMessage("search complete"),
    ]);

    const session = await runtime.createSession({
      customTools: [],
      builtinTools: ["grep", "find"],
      cwd: workspace,
    });
    await session.prompt("search the workspace");

    expect(modelToolNames).toEqual(["grep", "find"]);
    expect(session.toolNames()).toEqual(["grep", "find"]);
    expect(session.messages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolName: "grep",
          text: expect.stringContaining("needle.txt"),
        }),
      ])
    );
  });

  it("create, persist, resume in a new runtime instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-sess-"));
    const first = await piWithFaux(dir);
    first.faux.setResponses([fauxAssistantMessage("hello-from-parent")]);
    const agent = createThebeAgent({
      runtime: first.runtime,
      provider: emptyProvider(),
      agentStoreDir: join(dir, "meta"),
    });
    await expect(agent.send("hi")).resolves.toMatchObject({
      text: "hello-from-parent",
    });
    const meta = (await agent.listSessions())[0]!;
    expect(meta.runtimeId).toBe(PI_RUNTIME_ID);

    const second = await piWithFaux(dir);
    second.faux.setResponses([fauxAssistantMessage("resumed")]);
    const resumed = createThebeAgent({
      runtime: second.runtime,
      provider: emptyProvider(),
      agentStoreDir: join(dir, "meta"),
    });
    await resumed.resume(meta.thebeSessionId);
    const again = await resumed.send("again", meta.thebeSessionId);
    expect(again.text).toBe("resumed");
    const listed = await second.runtime.listSessions();
    expect(
      listed.some((row) => row.runtimeSessionId === meta.runtimeSessionId)
    ).toBe(true);
  });

  it("deletes the persisted Pi transcript with the Thebe session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-delete-"));
    const { faux, runtime } = await piWithFaux(dir);
    faux.setResponses([fauxAssistantMessage("delete-ready")]);
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
      agentStoreDir: join(dir, "meta"),
    });
    const meta = await agent.createSession({ title: "delete-real-session" });
    await agent.send("persist this", meta.thebeSessionId);
    expect((await readdir(dir)).some((name) => name.endsWith(".jsonl"))).toBe(
      true
    );

    await agent.deleteSession(meta.thebeSessionId);

    expect((await readdir(dir)).some((name) => name.endsWith(".jsonl"))).toBe(
      false
    );
    expect(await runtime.listSessions()).toHaveLength(0);
  });

  it("reports the effective thinking level and restores it after resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-thinking-"));
    const first = await piWithFaux(dir);
    const model = first.faux.getModel() as unknown as {
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    };
    model.reasoning = true;
    model.thinkingLevelMap = {
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    };
    const agent = createThebeAgent({
      runtime: first.runtime,
      provider: emptyProvider(),
      agentStoreDir: join(dir, "meta"),
    });
    const created = await agent.createSession();
    first.faux.setResponses([fauxAssistantMessage("seed")]);
    await agent.send("seed", created.thebeSessionId);
    await expect(
      agent.setThinkingLevel(created.thebeSessionId, "high")
    ).resolves.toMatchObject({ level: "high" });

    const second = await piWithFaux(dir);
    const resumedModel = second.faux.getModel() as unknown as {
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    };
    resumedModel.reasoning = true;
    resumedModel.thinkingLevelMap = model.thinkingLevelMap;
    const registeredResumedModel = second.modelRuntime.getModel(
      "faux",
      second.faux.getModel().id
    ) as unknown as {
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    };
    registeredResumedModel.reasoning = true;
    registeredResumedModel.thinkingLevelMap = model.thinkingLevelMap;
    const resumed = createThebeAgent({
      runtime: second.runtime,
      provider: emptyProvider(),
      agentStoreDir: join(dir, "meta"),
    });
    await resumed.resume(created.thebeSessionId);
    await expect(
      resumed.getThinkingInfo(created.thebeSessionId)
    ).resolves.toMatchObject({ level: "high" });
  });

  it("forwards Pi thinking and tool events through the agent log", async () => {
    const { faux, runtime } = await piWithFaux();
    const model = faux.getModel() as unknown as {
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    };
    model.reasoning = true;
    model.thinkingLevelMap = { high: "high" };
    faux.setResponses([
      fauxAssistantMessage([
        fauxThinking("inspect the workspace"),
        fauxToolCall("container.list", {}, { id: "call_container_list" }),
      ]),
      fauxAssistantMessage("tools are visible"),
    ]);
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
    });
    const created = await agent.createSession();
    const events: string[] = [];
    agent.subscribeLog(created.thebeSessionId, (event) => {
      events.push(event.type);
    });

    await agent.send("list containers", created.thebeSessionId);

    expect(events).toEqual(
      expect.arrayContaining([
        "thinking_delta",
        "tool_start",
        "tool_end",
        "text_delta",
      ])
    );
  });

  it("does not prompt for an ordinary read inside the configured workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "thebe-pi-workspace-read-"));
    await writeFile(join(workspace, "README.md"), "workspace file\n", "utf8");
    const { faux, runtime } = await piWithFaux();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("read", { path: "README.md" }, { id: "call_read" }),
      ]),
      fauxAssistantMessage("read complete"),
    ]);
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
      workspacePath: workspace,
    });

    const result = await agent.send("read the workspace file");

    expect(result.text).toBe("read complete");
    expect(
      result.events.some((event) => event.type === "permission_requested")
    ).toBe(false);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_start", toolName: "read" }),
        expect.objectContaining({
          type: "tool_end",
          toolName: "read",
          isError: false,
        }),
      ])
    );
  });

  it("fork does not mutate parent messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-fork-"));
    const { faux, runtime } = await piWithFaux(dir);
    faux.setResponses([
      fauxAssistantMessage("parent-only"),
      fauxAssistantMessage("child-only"),
    ]);
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
      agentStoreDir: join(dir, "meta"),
    });
    await agent.send("one");
    const parentMessages = agent.messages().map((m) => m.text);
    const parentId = agent.lastThebeSessionId()!;
    await agent.fork(parentId);
    await agent.send("two");
    const parentMeta = (await agent.listSessions()).find(
      (row) => row.thebeSessionId === parentId
    )!;
    const parentSession = await runtime.resumeSession(
      parentMeta.runtimeSessionId,
      {
        customTools: [],
      }
    );
    expect(parentSession.messages().map((m) => m.text)).toEqual(parentMessages);
  });

  it("compact then continue", async () => {
    const { faux, runtime } = await piWithFaux();
    faux.setResponses([
      fauxAssistantMessage("before-compact"),
      fauxAssistantMessage("after-compact"),
    ]);
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
    });
    await agent.send("one");
    await expect(agent.compact()).rejects.toThrow(/Nothing to compact/i);
    const continued = await agent.send("two");
    expect(continued.text.length).toBeGreaterThan(0);
    expect(agent.messages().length).toBeGreaterThan(0);
  });

  it("JSONL and HTML export include session turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-export-"));
    const { faux, runtime } = await piWithFaux(dir);
    faux.setResponses([fauxAssistantMessage("exported-turn")]);
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
    });
    await agent.send("say exported-turn");
    const cwd = process.cwd();
    const before = new Set(await readdir(cwd));
    const exported = await agent.exportSession();
    expect(exported.jsonl).toContain("exported-turn");
    expect(exported.html).toMatch(/<!doctype html/i);
    const b64 = exported.html.match(/[A-Za-z0-9+/]{80,}={0,2}/)?.[0] ?? "";
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain("exported-turn");
    const added = (await readdir(cwd)).filter((name) => !before.has(name));
    expect(
      added.filter(
        (name) =>
          name.endsWith(".jsonl") ||
          name.endsWith(".html") ||
          name.startsWith("session-") ||
          name.startsWith("pi-session-")
      )
    ).toEqual([]);
  });

  it("API key and OAuth go through ModelRuntime, Thebe has no refresh", async () => {
    const { runtime, modelRuntime } = await piWithFaux();
    const setSpy = vi.spyOn(modelRuntime, "setRuntimeApiKey");
    const loginSpy = vi.spyOn(modelRuntime, "login").mockResolvedValue({
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: Date.now() + 60_000,
    });
    await runtime.auth().setApiKey("faux", "sk-test");
    expect(setSpy).not.toHaveBeenCalled();
    expect(loginSpy).toHaveBeenCalledWith("faux", "apiKey", expect.any(Object));
    const apiKeyInteraction = loginSpy.mock.calls[0]?.[2];
    if (
      !apiKeyInteraction ||
      typeof apiKeyInteraction !== "object" ||
      !("prompt" in apiKeyInteraction) ||
      typeof apiKeyInteraction.prompt !== "function"
    )
      throw new Error("missing API key prompt");
    expect(await apiKeyInteraction.prompt({ message: "API key" })).toBe(
      "sk-test"
    );
    await runtime.auth().loginOAuth("faux", { type: "oauth" });
    expect(loginSpy).toHaveBeenLastCalledWith(
      "faux",
      "oauth",
      expect.any(Object)
    );
    const src = [
      await readFile(new URL("../runtime.ts", import.meta.url), "utf8"),
      await readFile(new URL("../auth/oauth.ts", import.meta.url), "utf8"),
    ].join("\n");
    expect(src).not.toMatch(/function refresh/);
    expect(src).not.toContain("refresh_token");
  });

  it("authorizeOAuth surfaces the provider auth URL without blocking", async () => {
    const { runtime, modelRuntime } = await piWithFaux();
    const loginSpy = vi
      .spyOn(modelRuntime, "login")
      .mockImplementation(async (...args: unknown[]) => {
        const interaction = args[2] as {
          notify: (event: {
            type: string;
            url?: string;
            instructions?: string;
          }) => void;
        };
        interaction.notify({
          type: "auth_url",
          url: "https://example.com/oauth/authorize",
          instructions: "open me",
        });
        return {
          type: "oauth",
          access: "a",
          refresh: "r",
          expires: Date.now() + 60_000,
        };
      });
    const result = await runtime.auth().authorizeOAuth("unauthorized-provider");
    expect(result).toMatchObject({
      pending: true,
      url: "https://example.com/oauth/authorize",
    });
    expect(loginSpy).toHaveBeenCalled();
    await expect(
      runtime.auth().submitOAuthCallback("unauthorized-provider", "code")
    ).rejects.toThrow("unknown OAuth authorization");
  });

  it("force authorizeOAuth starts a new login when credentials already exist", async () => {
    const { runtime, modelRuntime } = await piWithFaux();
    vi.spyOn(modelRuntime, "checkAuth").mockResolvedValue(true);
    const loginSpy = vi
      .spyOn(modelRuntime, "login")
      .mockImplementation(async (...args: unknown[]) => {
        const interaction = args[2] as {
          notify: (event: { type: string; url?: string }) => void;
        };
        interaction.notify({
          type: "auth_url",
          url: "https://example.com/renew",
        });
        return {
          type: "oauth",
          access: "renewed",
          refresh: "r",
          expires: Date.now() + 60_000,
        };
      });

    await runtime.auth().authorizeOAuth("connected-provider", { force: true });

    expect(loginSpy).toHaveBeenCalledOnce();
  });

  it("submitOAuthCallback feeds the prompt and waits for login to finish", async () => {
    const { runtime, modelRuntime } = await piWithFaux();
    let received = "";
    vi.spyOn(modelRuntime, "login").mockImplementation(
      async (...args: unknown[]) => {
        const interaction = args[2] as {
          prompt: () => Promise<string>;
          notify: (event: { type: string; url?: string }) => void;
        };
        interaction.notify({
          type: "auth_url",
          url: "https://example.com/oauth/google",
        });
        received = await interaction.prompt();
        return {
          type: "oauth",
          access: "a",
          refresh: "r",
          expires: Date.now() + 60_000,
        };
      }
    );
    const pending = await runtime.auth().authorizeOAuth("google");
    expect(pending).toMatchObject({
      pending: true,
      url: "https://example.com/oauth/google",
    });
    await runtime.auth().submitOAuthCallback("google", "pasted-from-tui");
    expect(received).toBe("pasted-from-tui");
  });

  it("agent metadata files omit transcript payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-meta-"));
    const { faux, runtime } = await piWithFaux(dir);
    faux.setResponses([fauxAssistantMessage("secret-turn")]);
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
      agentStoreDir: join(dir, "meta"),
    });
    await agent.send("hi");
    const names = await readdir(join(dir, "meta"));
    const raw = await readFile(join(dir, "meta", names[0]!), "utf8");
    expect(raw).not.toContain("secret-turn");
    expect(raw).not.toContain("transcript");
    expect(raw).not.toContain("refresh_token");
  });
});
