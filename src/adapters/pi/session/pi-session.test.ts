import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
    // The micro-VM needs the package plus a VM backend (QEMU images).
    require.resolve("@earendil-works/gondolin");
    const probe = spawnSync("qemu-img", ["--version"], { stdio: "ignore" });
    return probe.status === 0;
  } catch {
    return false;
  }
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

describe("PiCodingAgentRuntime sessions", () => {
  it("rejects a terminal model failure and allows the next turn to recover", async () => {
    const { faux, runtime } = await piWithFaux();
    const agent = createThebeAgent({ runtime, provider: emptyProvider() });
    const session = await agent.createSession();
    const events: string[] = [];
    agent.subscribeLog(session.thebeSessionId, (event) => events.push(event.type));
    faux.setResponses([fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "FreeTierError: free tier requires the OpenCode client",
    })]);

    await expect(agent.prompt("hello", { thebeSessionId: session.thebeSessionId }))
      .rejects.toThrow("FreeTierError");
    expect(events.filter((type) => type === "error")).toHaveLength(1);
    expect(events).not.toContain("session_end");
    expect(await agent.loadMessages(session.thebeSessionId)).toContainEqual(
      expect.objectContaining({ role: "assistant", isError: true }),
    );

    faux.setResponses([fauxAssistantMessage("recovered")]);
    await expect(agent.prompt("try again", { thebeSessionId: session.thebeSessionId }))
      .resolves.toMatchObject({ text: "recovered" });
    expect(events.filter((type) => type === "session_end")).toHaveLength(1);
  });

  it("tracks and stops detached bash background tasks", async () => {
    const { faux, runtime } = await piWithFaux();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "sleep 60 >/dev/null 2>&1 &" }, { id: "call_bg" }),
      ]),
      fauxAssistantMessage("started"),
    ]);
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
      permissionMode: "full-access",
    });
    const session = await agent.createSession();

    await expect(agent.send("start a background task", session.thebeSessionId)).resolves.toMatchObject({
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
    await expect(agent.listBackgroundTasks(session.thebeSessionId)).resolves.toEqual([
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
        fauxToolCall("bash", { command: "sleep 60 >/dev/null 2>&1 &" }, { id: "call_bg_recovery" }),
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
      const started = await firstAgent.listBackgroundTasks(session.thebeSessionId);
      taskId = started[0]?.id;
      expect(taskId).toEqual(expect.any(String));

      const second = await piWithFaux(dir);
      const resumed = createThebeAgent({
        runtime: second.runtime,
        provider: emptyProvider(),
        agentStoreDir: join(dir, "meta"),
        permissionMode: "full-access",
      });

      await expect(resumed.listBackgroundTasks(session.thebeSessionId)).resolves.toEqual([
        expect.objectContaining({
          id: taskId,
          name: "sleep 60 >/dev/null 2>&1 &",
          status: "running",
          pid: expect.any(Number),
        }),
      ]);
      await resumed.stopBackgroundTask(session.thebeSessionId, taskId!);
    } finally {
      if (taskId) await firstAgent.stopBackgroundTask(session.thebeSessionId, taskId);
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
        "sleep 60 >/dev/null 2>&1 &",
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
      if (taskId) await agent.stopBackgroundTask(session.thebeSessionId, taskId);
    }
  });

  it("routes bash through the Micro-VM backend when THEBE_SANDBOX=gondolin", async () => {
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

      // @earendil-works/gondolin is an optional runtime dependency: when the
      // package and a VM backend are present the command runs inside the guest;
      // otherwise the tool call must fail loudly instead of touching the host.
      await expect(
        agent.send("run uname in the vm", session.thebeSessionId),
      ).resolves.toMatchObject({ text: "done" });
      const transcript = JSON.stringify(
        await agent.loadMessages(session.thebeSessionId),
      );
      if (gondolinMicroVmAvailable()) {
        expect(transcript).toContain("Linux");
        expect(transcript).toContain("toolName\":\"bash");
      } else {
        expect(transcript).toContain("Gondolin Micro-VM is unavailable");
      }
    } finally {
      if (previous === undefined) delete process.env.THEBE_SANDBOX;
      else process.env.THEBE_SANDBOX = previous;
    }
  });

  it("exposes Pi native content and filename search without bash", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "thebe-pi-search-tools-"));
    await writeFile(join(workspace, "needle.txt"), "needle in workspace\n", "utf8");
    const { faux, runtime } = await piWithFaux();
    let modelToolNames: string[] | undefined;
    faux.setResponses([
      (context) => {
        modelToolNames = getCurrentTools(context.messages).map((tool) => tool.name);
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
      ]),
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
    expect(listed.some((row) => row.runtimeSessionId === meta.runtimeSessionId)).toBe(
      true,
    );
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
    expect((await readdir(dir)).some((name) => name.endsWith(".jsonl"))).toBe(true);

    await agent.deleteSession(meta.thebeSessionId);

    expect((await readdir(dir)).some((name) => name.endsWith(".jsonl"))).toBe(false);
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
    await expect(agent.setThinkingLevel(created.thebeSessionId, "high"))
      .resolves.toMatchObject({ level: "high" });

    const second = await piWithFaux(dir);
    const resumedModel = second.faux.getModel() as unknown as {
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    };
    resumedModel.reasoning = true;
    resumedModel.thinkingLevelMap = model.thinkingLevelMap;
    const registeredResumedModel = second.modelRuntime.getModel(
      "faux",
      second.faux.getModel().id,
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
    await expect(resumed.getThinkingInfo(created.thebeSessionId))
      .resolves.toMatchObject({ level: "high" });
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
      ]),
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
    expect(result.events.some((event) => event.type === "permission_requested")).toBe(
      false,
    );
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_start", toolName: "read" }),
        expect.objectContaining({ type: "tool_end", toolName: "read", isError: false }),
      ]),
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
      (row) => row.thebeSessionId === parentId,
    )!;
    const parentSession = await runtime.resumeSession(
      parentMeta.runtimeSessionId,
      {
        customTools: [],
      },
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
          name.startsWith("pi-session-"),
      ),
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
    expect(setSpy).toHaveBeenCalledWith("faux", "sk-test");
    await runtime.auth().loginOAuth("faux", { type: "oauth" });
    expect(loginSpy).toHaveBeenCalled();
    const src = [
      await readFile(
        new URL("../runtime.ts", import.meta.url),
        "utf8",
      ),
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
    const result = await runtime
      .auth()
      .authorizeOAuth("unauthorized-provider");
    expect(result).toMatchObject({
      pending: true,
      url: "https://example.com/oauth/authorize",
    });
    expect(loginSpy).toHaveBeenCalled();
    await expect(
      runtime.auth().submitOAuthCallback("unauthorized-provider", "code"),
    ).rejects.toThrow("unknown OAuth authorization");
  });

  it("force authorizeOAuth starts a new login when credentials already exist", async () => {
    const { runtime, modelRuntime } = await piWithFaux();
    vi.spyOn(modelRuntime, "checkAuth").mockResolvedValue(true);
    const loginSpy = vi.spyOn(modelRuntime, "login").mockImplementation(async (...args: unknown[]) => {
      const interaction = args[2] as {
        notify: (event: { type: string; url?: string }) => void;
      };
      interaction.notify({ type: "auth_url", url: "https://example.com/renew" });
      return { type: "oauth", access: "renewed", refresh: "r", expires: Date.now() + 60_000 };
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
      },
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
