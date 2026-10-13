import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "./capabilities/containers.ts";
import { createMcpClientRegistry } from "../adapters/mcp/index.ts";
import { createFakeRuntime } from "../testing/runtime/index.ts";
import { createThebeApp } from "../app/create.ts";
import { hashParameters } from "../agent/security/audit/audit-log.ts";
import { createThebeAgent, DEFAULT_AUTO_SUMMARY_DELAY_MS } from "./index.ts";
import { createJsonAgentSettingsStore } from "./settings/store.ts";

const CANARY = "sk-canary-s3cret-leak";

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

describe("Thebe agent service (fake runtime)", () => {
  it("does not send an already approved or denied command to the approval UI", async () => {
    const fake = createFakeRuntime();
    let handler: Parameters<
      typeof fake.runtime.createSession
    >[0]["permissionHandler"];
    const agent = createThebeAgent({
      runtime: {
        ...fake.runtime,
        async createSession(options) {
          handler = options.permissionHandler;
          return fake.runtime.createSession(options);
        },
      },
      provider: emptyProvider(),
      permissionMode: "full-access",
    });
    const session = await agent.createSession();
    const request = {
      permissionId: "p",
      toolCallId: "c",
      toolName: "bash",
      args: { command: "ls" },
    };
    expect(await handler!.preflight!(request)).toBe("allow");
    await agent.patchSession(session.thebeSessionId, {
      rememberedPermissions: { bash: "deny" },
    });
    expect(await handler!.preflight!(request)).toBe("deny");
    await agent.patchSession(session.thebeSessionId, {
      rememberedPermissions: { bash: "allow" },
    });
    agent.setPermissionMode("ask");
    expect(await handler!.preflight!(request)).toBe("allow");
    agent.setPermissionMode("read-only");
    expect(await handler!.preflight!(request)).toBe("deny");
    agent.setPermissionMode("full-access");
    expect(
      await handler!.preflight!({
        ...request,
        args: { command: "zpool destroy tank" },
      })
    ).toBe("deny");
  });

  it("refreshes an existing conversation when a resource is enabled, updated or removed", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const session = await agent.createSession();
    const resource = {
      kind: "skill" as const,
      identity: "demo",
      source: "thebe://skills/demo",
      version: "1",
    };
    await agent.enableResource(resource);
    expect(fake.snapshot(session.runtimeSessionId).resourceReloads).toBe(1);
    await agent.putEnabledResource({ ...resource, version: "2" });
    expect(fake.snapshot(session.runtimeSessionId).resourceReloads).toBe(2);
    await agent.removeEnabledResource("demo");
    expect(fake.snapshot(session.runtimeSessionId).resourceReloads).toBe(3);
  });

  it("uses a two-minute idle default for automatic summaries", () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });

    expect(DEFAULT_AUTO_SUMMARY_DELAY_MS).toBe(120_000);
    expect(agent.autoSummaryDelayMs()).toBe(120_000);
  });

  it("passes one configured workspace to runtime sessions and permission policy", async () => {
    const fake = createFakeRuntime();
    const workspace = await mkdtemp(
      join(tmpdir(), "thebe-configured-workspace-")
    );
    const outputDirectory = join(workspace, ".thebe", "outputs");
    const createCalls: Array<Parameters<typeof fake.runtime.createSession>[0]> =
      [];
    const runtime = {
      ...fake.runtime,
      async createSession(
        create: Parameters<typeof fake.runtime.createSession>[0]
      ) {
        createCalls.push(create);
        return fake.runtime.createSession(create);
      },
    };
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
      workspacePath: workspace,
      outputDirectory,
    });

    await agent.createSession();

    const create = createCalls[0]!;
    expect(create.cwd).toBe(workspace);
    expect(create.workspacePath).toBe(workspace);
    expect(
      await create.permissionHandler?.preflight?.({
        permissionId: "p",
        toolName: "read",
        toolCallId: "c",
        args: { path: "README.md" },
      })
    ).toBe("allow");
    expect(
      await create.permissionHandler?.preflight?.({
        permissionId: "p2",
        toolName: "read",
        toolCallId: "c2",
        args: { path: "../outside.txt" },
      })
    ).toBe("ask");
  });

  it("denies critical commands and asks before running dangerous ones", async () => {
    const fake = createFakeRuntime();
    const workspace = await mkdtemp(join(tmpdir(), "thebe-command-guard-"));
    const createCalls: Array<Parameters<typeof fake.runtime.createSession>[0]> =
      [];
    const runtime = {
      ...fake.runtime,
      async createSession(
        create: Parameters<typeof fake.runtime.createSession>[0]
      ) {
        createCalls.push(create);
        return fake.runtime.createSession(create);
      },
    };
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
      workspacePath: workspace,
    });

    await agent.createSession();
    const preflight = createCalls[0]!.permissionHandler!.preflight!;
    const bash = (command: string) => ({
      permissionId: "p",
      toolName: "bash",
      toolCallId: "c",
      args: { command },
    });

    // Storage destruction and disk writes are policy-denied, not approvable.
    expect(await preflight(bash("zpool destroy tank"))).toBe("deny");
    expect(await preflight(bash("mkfs.ext4 /dev/sdb1"))).toBe("deny");
    expect(await preflight(bash("rm -rf /"))).toBe("deny");
    // Container breakouts need a human, not an outright denial.
    expect(await preflight(bash("docker run --privileged nginx"))).toBe("ask");
    // Ordinary commands keep the pre-guard behaviour of asking for approval.
    expect(await preflight(bash("ls -la"))).toBe("ask");
    expect(
      await preflight({
        permissionId: "p2",
        toolName: "write",
        toolCallId: "c2",
        args: { path: "/etc/sudoers", content: "x" },
      })
    ).toBe("ask");
  });

  it("lets THEBE_COMMAND_GUARD=off fall back to plain approvals", async () => {
    vi.stubEnv("THEBE_COMMAND_GUARD", "off");
    try {
      const fake = createFakeRuntime();
      const createCalls: Array<
        Parameters<typeof fake.runtime.createSession>[0]
      > = [];
      const runtime = {
        ...fake.runtime,
        async createSession(
          create: Parameters<typeof fake.runtime.createSession>[0]
        ) {
          createCalls.push(create);
          return fake.runtime.createSession(create);
        },
      };
      const agent = createThebeAgent({ runtime, provider: emptyProvider() });
      await agent.createSession();
      const preflight = createCalls[0]!.permissionHandler!.preflight!;
      expect(
        await preflight({
          permissionId: "p",
          toolName: "bash",
          toolCallId: "c",
          args: { command: "zpool destroy tank" },
        })
      ).toBe("ask");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never treats the host process directory as an implicit workspace", async () => {
    const fake = createFakeRuntime();
    const createCalls: Array<Parameters<typeof fake.runtime.createSession>[0]> =
      [];
    const runtime = {
      ...fake.runtime,
      async createSession(
        create: Parameters<typeof fake.runtime.createSession>[0]
      ) {
        createCalls.push(create);
        return fake.runtime.createSession(create);
      },
    };
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
    });

    await agent.createSession();

    const create = createCalls[0]!;
    expect(create.cwd).toBeUndefined();
    expect(create.workspacePath).toBeUndefined();
    expect(create.systemPrompt).toContain("No workspace is configured");
    await expect(
      create.permissionHandler?.preflight?.({
        permissionId: "p",
        toolName: "read",
        toolCallId: "c",
        args: { path: "README.md" },
      })
    ).resolves.toBe("ask");
  });

  it("gives the main session the explicit response and file-output policy", async () => {
    const fake = createFakeRuntime();
    const createCalls: Array<Parameters<typeof fake.runtime.createSession>[0]> =
      [];
    const runtime = {
      ...fake.runtime,
      async createSession(
        create: Parameters<typeof fake.runtime.createSession>[0]
      ) {
        createCalls.push(create);
        return fake.runtime.createSession(create);
      },
    };
    const agent = createThebeAgent({
      runtime,
      provider: emptyProvider(),
      workspacePath: await mkdtemp(join(tmpdir(), "thebe-prompt-policy-")),
    });

    await agent.createSession();
    const systemPrompt = createCalls[0]?.systemPrompt ?? "";

    expect(systemPrompt).toContain(
      "Return ordinary answers and research results to the parent conversation buffer by default."
    );
    expect(systemPrompt).toContain(
      "Reply style: put the answer or result in the first sentence"
    );
    expect(systemPrompt).toContain(
      "never show instance or item UUIDs, error codes"
    );
    expect(systemPrompt).toContain("thebe:suggest");
    expect(systemPrompt).toContain("thebe:gallery");
    expect(systemPrompt).toContain('```thebe:gallery\n{"images"');
    expect(systemPrompt).toContain("Never invent media URLs");
    expect(systemPrompt).toContain(
      "Write files only when the user explicitly asks to create, save, or export a file, or when the coding task itself requires changing repository files."
    );
    expect(systemPrompt).toContain(
      "Never create output.md, docs files, or any other file merely to display an answer."
    );
    expect(systemPrompt).toContain(
      "outputDirectory is only the default destination for explicitly requested non-code artifacts; it is not an instruction to write output."
    );
    expect(systemPrompt).toContain(
      "Use Pi's native find for filename searches and Pi's native grep for content searches."
    );
    expect(systemPrompt).toContain(
      "Do not use bash or rg for ordinary searches."
    );
    expect(systemPrompt).toContain(
      "Use bash only when the task genuinely requires executing a shell command."
    );
  });

  it("asks through Thebe-owned events, not Pi event types", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const result = await agent.send("ping");
    expect(result.text).toBe("pong");
    expect(result.events.map((event) => event.type)).toEqual([
      "text_delta",
      "turn_end",
      "session_end",
    ]);
    expect(JSON.stringify(result.events)).not.toContain("message_update");
    expect(JSON.stringify(result.events)).not.toContain(
      "assistantMessageEvent"
    );
  });

  it("drives a goal through isolated worker and independent reviewer children", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "text",
        text: "I inspected the workspace and completed the checkpoint.",
      },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: pnpm test — all tests pass\nREMAINING: none",
      },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const session = await agent.createSession({ title: "goal" });

    await agent.startGoal({
      thebeSessionId: session.thebeSessionId,
      goal: "Finish the refactor",
      criteria: ["tests pass"],
      maxIterations: 3,
    });

    await expect(agent.waitGoal(session.thebeSessionId)).resolves.toMatchObject(
      {
        status: "completed",
        iteration: 1,
        subagentRunIds: expect.arrayContaining([
          expect.any(String),
          expect.any(String),
        ]),
      }
    );
    expect(agent.getGoal(session.thebeSessionId)).toMatchObject({
      status: "completed",
      iteration: 1,
      finalReport: expect.stringContaining("VERDICT: pass"),
    });
    expect(agent.messages()).toEqual([]);
    await expect(
      agent.listSubagents(session.thebeSessionId)
    ).resolves.toHaveLength(2);
    expect(
      (await agent.listSubagents(session.thebeSessionId)).map(
        (run) => run.profileName
      )
    ).toEqual(["goal-worker", "goal-reviewer"]);
  });

  it("restores completed Goal and child results from the saved session metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-goal-resume-"));
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "persisted worker result" },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: persisted child evidence\nREMAINING: none",
      },
    ]);
    const firstProduct = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      agentStoreDir: dir,
    });
    const session = await firstProduct.createSession({
      title: "persisted goal",
    });
    await firstProduct.startGoal({
      thebeSessionId: session.thebeSessionId,
      goal: "Persist the verified goal result",
      maxIterations: 2,
    });
    await firstProduct.waitGoal(session.thebeSessionId);

    const resumedProduct = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      agentStoreDir: dir,
    });
    await resumedProduct.resume(session.thebeSessionId);

    expect(resumedProduct.getGoal(session.thebeSessionId)).toMatchObject({
      status: "completed",
      finalReport: expect.stringContaining("persisted child evidence"),
    });
    expect(
      (await resumedProduct.listSubagents(session.thebeSessionId)).map(
        (run) => run.result
      )
    ).toEqual([
      "persisted worker result",
      "VERDICT: pass\nEVIDENCE: persisted child evidence\nREMAINING: none",
    ]);
  });

  it("pauses and resumes a goal with a fresh child checkpoint", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const session = await agent.createSession({ title: "goal-pause" });
    await agent.startGoal({
      thebeSessionId: session.thebeSessionId,
      goal: "Finish the task",
      maxIterations: 3,
    });

    await vi.waitFor(() => {
      expect(
        agent.getGoal(session.thebeSessionId)?.activeSubagent?.status
      ).toBe("running");
    });
    await agent.pauseGoal(session.thebeSessionId);
    await expect(agent.waitGoal(session.thebeSessionId)).resolves.toMatchObject(
      {
        status: "paused",
        iteration: 1,
      }
    );

    fake.queueTurns([
      { kind: "text", text: "checkpoint complete" },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: task artifact exists\nREMAINING: none",
      },
    ]);
    await agent.resumeGoal(session.thebeSessionId);
    await expect(agent.waitGoal(session.thebeSessionId)).resolves.toMatchObject(
      {
        status: "completed",
        iteration: 2,
      }
    );
    await expect(
      agent.listSubagents(session.thebeSessionId)
    ).resolves.toHaveLength(3);
  });

  it("registers Pi built-ins together with container tools", () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    expect(agent.toolNames()).toEqual(
      expect.arrayContaining([
        "ls",
        "bash",
        "read",
        "edit",
        "write",
        "container.list",
        "container.inspect",
      ])
    );
  });

  it("redacts a canary secret from custom-tool success events and messages", async () => {
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      inspectContainer: async () => ({
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        config: { env: [`API_TOKEN=${CANARY}`] },
      }),
    };
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [{ name: "container.inspect", args: { id: "abc123" } }],
      },
      { kind: "text", text: "inspected" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider,
    });
    const result = await agent.send("inspect");
    expect(result.text).toBe("inspected");
    const dumped = JSON.stringify({
      events: result.events,
      messages: agent.messages(),
    });
    expect(dumped).not.toContain(CANARY);
    expect(dumped).toContain("***REDACTED***");
  });

  it("HTTP session prompt and TUI share the agent from createThebeApp", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "shared" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: emptyProvider(),
      version: "0.1.0",
    });
    const created = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session", { method: "POST" })
    );
    const session = (await created.json()) as { thebeSessionId: string };
    const http = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello" }),
        }
      )
    );
    expect(http.status).toBe(200);
    await expect(http.json()).resolves.toMatchObject({
      text: "shared",
      tools: [],
      thebeSessionId: session.thebeSessionId,
    });
    expect(app.send).toBeTypeOf("function");
  });

  it("AgentStore files contain mapping keys only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-meta-"));
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "ok" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      agentStoreDir: dir,
    });
    await agent.send("hi");
    const listed = await agent.listSessions();
    expect(listed).toHaveLength(1);
    const raw = await readFile(
      join(dir, `${listed[0]!.thebeSessionId}.json`),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.thebeSessionId).toBe(listed[0]!.thebeSessionId);
    expect(parsed.runtimeId).toBeDefined();
    expect(parsed.runtimeSessionId).toBeDefined();
    expect(parsed.createdAt).toBeDefined();
    expect(parsed.lastActiveAt).toBeDefined();
    expect(parsed.title).toBe("hi");
    expect(raw).not.toContain("pong");
    expect(raw).not.toContain("transcript");
  });

  it("fork leaves parent messages unchanged", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "parent-turn" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await agent.send("one");
    const parentId = agent.lastThebeSessionId()!;
    const before = agent.messages().map((message) => message.text);
    await agent.fork(parentId);
    const parent = fake.snapshot(
      (await agent.listSessions()).find(
        (row) => row.thebeSessionId === parentId
      )!.runtimeSessionId
    );
    expect(parent.messages.map((message) => message.text)).toEqual(before);
  });

  it("compact then continue", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await agent.send("one");
    await agent.compact();
    const continued = await agent.send("two");
    expect(continued.text).toBe("second");
    expect(fake.compactCalls()).toBe(1);
  });

  it("deletes both the Thebe mapping and the underlying runtime session", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const meta = await agent.createSession({ title: "delete-me" });

    await agent.deleteSession(meta.thebeSessionId);

    await expect(agent.getSession(meta.thebeSessionId)).rejects.toThrow();
    expect(await fake.runtime.listSessions()).not.toContainEqual({
      runtimeSessionId: meta.runtimeSessionId,
    });
  });

  it("passes compact instructions and toggles official auto-compact", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "first" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const meta = await agent.createSession();
    const before = await agent.getContextUsage(meta.thebeSessionId);
    expect(before.compaction.enabled).toBe(true);
    await agent.send("one");
    await agent.compact(meta.thebeSessionId, "keep the API decisions");
    expect(fake.compactCalls()).toBe(1);
    expect(fake.compactInstructions()).toEqual(["keep the API decisions"]);
    const after = await agent.getContextUsage(meta.thebeSessionId);
    expect(after.compaction.lastCompactedAt).toBeDefined();
    await agent.setAutoCompactionEnabled(meta.thebeSessionId, false);
    const disabled = await agent.getContextUsage(meta.thebeSessionId);
    expect(disabled.compaction.enabled).toBe(false);
    expect(disabled.compaction.nearThreshold).toBe(false);
  });

  it("generates and persists an automatic summary after idle time", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeRuntime();
      fake.queueTurns([{ kind: "text", text: "completed" }]);
      const agent = createThebeAgent({
        runtime: fake.runtime,
        provider: emptyProvider(),
        autoSummaryDelayMs: 60_000,
      });
      const result = await agent.send("finish the task");
      const events: string[] = [];
      agent.subscribeLog(result.thebeSessionId, (event) => {
        events.push(event.type);
      });

      await vi.advanceTimersByTimeAsync(60_000);

      const meta = await agent.getSession(result.thebeSessionId);
      expect(meta.lastSummary).toBe("ok");
      expect(meta.lastSummaryAt).toBeDefined();
      expect(events).toContain("summary_ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records enabled skill identity/version/source in audit and does not auto-load extras", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const fake = createFakeRuntime();
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      auditPath,
    });
    expect(agent.enabledResources()).toEqual([]);
    await agent.enableResource({
      kind: "skill",
      identity: "homelab-status",
      version: "1.0.0",
      source: "thebe://skills/homelab-status",
    });
    const row = JSON.parse(
      (await readFile(auditPath, "utf8")).trim()
    ) as Record<string, unknown>;
    expect(row).toMatchObject({
      method: "resource.enable",
      identity: "homelab-status",
      version: "1.0.0",
      source: "thebe://skills/homelab-status",
    });
    expect(agent.enabledResources()).toHaveLength(1);
  });

  it("restores enabled resources after the Agent is recreated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-resources-config-"));
    const settingsStore = createJsonAgentSettingsStore(
      join(dir, "config.json")
    );
    const resource = {
      kind: "skill" as const,
      identity: "homelab-status",
      version: "1.0.0",
      source: "thebe://skills/homelab-status",
    };

    const first = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: emptyProvider(),
      settingsStore,
    });
    await first.putEnabledResource(resource);

    const second = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: emptyProvider(),
      settingsStore,
    });

    expect(second.enabledResources()).toEqual([resource]);
  });

  it("persists removing an enabled resource", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-resources-remove-"));
    const settingsStore = createJsonAgentSettingsStore(
      join(dir, "config.json")
    );
    const resource = {
      kind: "skill" as const,
      identity: "homelab-status",
      version: "1.0.0",
      source: "thebe://skills/homelab-status",
    };

    const first = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: emptyProvider(),
      settingsStore,
    });
    await first.putEnabledResource(resource);

    const second = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: emptyProvider(),
      settingsStore,
    });
    await expect(second.removeEnabledResource(resource.identity)).resolves.toBe(
      true
    );

    const third = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: emptyProvider(),
      settingsStore,
    });

    expect(third.enabledResources()).toEqual([]);
  });

  it("persists enabling a skill through the Skill interface", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-skill-config-"));
    await mkdir(join(dir, ".thebe", "skills", "demo-skill"), {
      recursive: true,
    });
    await writeFile(
      join(dir, ".thebe", "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill\n---\nbody\n"
    );
    const settingsStore = createJsonAgentSettingsStore(
      join(dir, "config.json")
    );

    const first = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: emptyProvider(),
      workspacePath: dir,
      settingsStore,
    });
    await first.enableSkill("demo-skill");

    const second = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: emptyProvider(),
      workspacePath: dir,
      settingsStore,
    });

    expect((await second.getSkill("demo-skill"))?.enabled).toBe(true);
  });

  it("MCP tools/call uses the same agent invokeTool path", async () => {
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      getStatusSummary: async () => ({
        totalContainers: 4,
        runningContainers: 2,
        pausedContainers: 0,
        exitedContainers: 2,
        lastUpdated: 1,
      }),
    };
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider,
      version: "0.1.0",
    });
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "container.status_summary" },
        }),
      })
    );
    const body = (await res.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(body.result?.content?.[0]?.text).toContain("runningContainers");
  });

  it("prompt accepts files and records them on the user message", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "saw-file" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const result = await agent.prompt({
      text: "look",
      files: [{ mediaType: "image/png", data: "aaaa", filename: "shot.png" }],
    });
    expect(result.text).toBe("saw-file");
    expect(agent.messages()[0]?.text).toContain("shot.png");
    expect(agent.messages()[0]?.text).toContain("image/png");
  });

  it("forks from a specific message id", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await agent.prompt("one");
    const firstAssistant = agent.messages()[1]!;
    await agent.prompt("two");
    const parentId = agent.lastThebeSessionId()!;
    const child = await agent.fork(parentId, firstAssistant.id);
    expect(child.parentThebeSessionId).toBe(parentId);
    expect(agent.messages().map((message) => message.text)).toEqual([
      "one",
      "first",
    ]);
    const kids = await agent.children(parentId);
    expect(kids.map((row) => row.thebeSessionId)).toEqual([
      child.thebeSessionId,
    ]);
  });

  it("reverts and unreverts the last user turn", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await agent.prompt("ping");
    await agent.revert();
    expect(agent.messages()).toEqual([]);
    await agent.unrevert();
    expect(agent.messages().map((message) => message.text)).toEqual([
      "ping",
      "pong",
    ]);
  });

  it("holds bash until permission is resolved", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const pending = agent.prompt("run bash");
    await vi.waitFor(() => {
      expect(agent.pendingPermissionIds().length).toBe(1);
    });
    const permissionId = agent.pendingPermissionIds()[0]!;
    const sessionId = agent.lastThebeSessionId()!;
    expect(
      agent.lastEvents().some((event) => event.type === "permission_requested")
    ).toBe(true);
    await agent.resolvePermission(sessionId, permissionId, {
      response: "deny",
    });
    const result = await pending;
    expect(result.text).toBe("after");
    const tool = agent.messages().find((message) => message.role === "tool");
    expect(tool?.isError).toBe(true);
    expect(tool?.text).toContain("denied");
  });

  it("remember:true persists the approval decision on the session meta", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const pending = agent.prompt("run bash");
    await vi.waitFor(() => {
      expect(agent.pendingPermissionIds().length).toBe(1);
    });
    const permissionId = agent.pendingPermissionIds()[0]!;
    const sessionId = agent.lastThebeSessionId()!;
    await agent.resolvePermission(sessionId, permissionId, {
      response: "allow",
      remember: true,
    });
    await pending;
    const meta = await agent.getSession(sessionId);
    expect(meta.rememberedPermissions?.bash).toBeUndefined();
    expect(
      meta.rememberedPermissions?.[`bash:${hashParameters({ command: "ls" })}`]
    ).toBe("allow");
  });

  it("re-reads rememberedPermissions at tool dispatch so a later deny sticks", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const sessionId = (await agent.createSession()).thebeSessionId;
    await agent.patchSession(sessionId, {
      rememberedPermissions: { bash: "deny" },
    });
    const result = await agent.prompt("run bash", {
      thebeSessionId: sessionId,
    });
    expect(result.text).toBe("after");
    expect(agent.pendingPermissionIds()).toHaveLength(0);
    const tool = agent.messages().find((message) => message.role === "tool");
    expect(tool?.isError).toBe(true);
    expect(tool?.text).toContain("denied");
  });

  it("full-access auto-approves approval-gated tools while explicit deny wins", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      permissionMode: "full-access",
    });
    const result = await agent.send("run bash");
    expect(result.text).toBe("after");
    expect(agent.permissionMode()).toBe("full-access");
    expect(agent.pendingPermissionIds()).toHaveLength(0);

    const denied = createFakeRuntime();
    denied.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "denied after" },
    ]);
    const guarded = createThebeAgent({
      runtime: denied.runtime,
      provider: emptyProvider(),
      permissionMode: "full-access",
    });
    const session = await guarded.createSession();
    await guarded.patchSession(session.thebeSessionId, {
      rememberedPermissions: { bash: "deny" },
    });
    await guarded.prompt("run bash", {
      thebeSessionId: session.thebeSessionId,
    });
    expect(
      guarded.messages().find((message) => message.role === "tool")?.isError
    ).toBe(true);
  });

  it("read-only mode denies approval-gated tools without opening a permission prompt", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "read-only" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      permissionMode: "read-only",
    });
    const result = await agent.send("run bash");
    expect(result.text).toBe("read-only");
    expect(agent.permissionMode()).toBe("read-only");
    expect(agent.pendingPermissionIds()).toHaveLength(0);
  });

  it("host-gates the full-access preset and applies it to one session only", async () => {
    const disabled = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: emptyProvider(),
    });
    expect(disabled.getFullAccessSupport()).toEqual({ allowed: false });
    const disabledSession = await disabled.createSession();
    await expect(
      disabled.setSessionFullAccess(disabledSession.thebeSessionId, true)
    ).rejects.toMatchObject({
      status: 403,
      code: "full_access_not_allowed",
    });

    const fake = createFakeRuntime();
    const handlers: Array<
      NonNullable<
        Parameters<typeof fake.runtime.createSession>[0]["permissionHandler"]
      >
    > = [];
    const agent = createThebeAgent({
      runtime: {
        ...fake.runtime,
        async createSession(options) {
          if (options.permissionHandler)
            handlers.push(options.permissionHandler);
          return fake.runtime.createSession(options);
        },
      },
      provider: emptyProvider(),
      fullAccessAllowed: true,
    });
    expect(agent.getFullAccessSupport()).toEqual({ allowed: true });
    const first = await agent.createSession();
    await agent.createSession();
    const firstHandler = handlers[0]!;
    const secondHandler = handlers[1]!;
    const request = {
      permissionId: "p",
      toolCallId: "c",
      toolName: "bash",
      args: { command: "ls" },
    };
    const critical = { ...request, args: { command: "zpool destroy tank" } };

    expect(await firstHandler.preflight!(request)).toBe("ask");
    expect(await firstHandler.preflight!(critical)).toBe("deny");

    await agent.setSessionFullAccess(first.thebeSessionId, true);
    expect(await firstHandler.preflight!(request)).toBe("allow");
    // The command guard is lifted for the enabled session only.
    expect(await firstHandler.preflight!(critical)).toBe("allow");
    expect(await secondHandler.preflight!(request)).toBe("ask");
    expect((await agent.getSession(first.thebeSessionId)).fullAccess).toBe(
      true
    );

    await agent.setSessionFullAccess(first.thebeSessionId, false);
    expect(await firstHandler.preflight!(request)).toBe("ask");

    // An explicit remembered denial still wins while the preset is on.
    await agent.setSessionFullAccess(first.thebeSessionId, true);
    await agent.patchSession(first.thebeSessionId, {
      rememberedPermissions: { bash: "deny" },
    });
    expect(await firstHandler.preflight!(request)).toBe("deny");
  });

  it("applies the preset to an auto-created session that had no explicit id", async () => {
    const fake = createFakeRuntime();
    const fullAccessOptions: Array<() => boolean> = [];
    const agent = createThebeAgent({
      runtime: {
        ...fake.runtime,
        async createSession(options) {
          if (options.fullAccess) fullAccessOptions.push(options.fullAccess);
          return fake.runtime.createSession(options);
        },
      },
      provider: emptyProvider(),
      fullAccessAllowed: true,
    });
    fake.queueTurns([{ kind: "text", text: "hi" }]);
    await agent.send("hello");
    const sessionId = agent.lastThebeSessionId()!;
    expect(fullAccessOptions[0]!()).toBe(false);
    await agent.setSessionFullAccess(sessionId, true);
    expect(fullAccessOptions[0]!()).toBe(true);
  });

  it("runs approval-gated tools under the full-access preset without prompting", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      fullAccessAllowed: true,
    });
    const session = await agent.createSession();
    await agent.setSessionFullAccess(session.thebeSessionId, true);
    const result = await agent.send("run bash", session.thebeSessionId);
    expect(result.text).toBe("after");
    expect(agent.pendingPermissionIds()).toHaveLength(0);
  });

  it("does not apply the full-access preset to a non-interactive turn", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "background" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      fullAccessAllowed: true,
    });
    const session = await agent.createSession();
    await agent.setSessionFullAccess(session.thebeSessionId, true);
    await agent.prompt("run bash", {
      thebeSessionId: session.thebeSessionId,
      nonInteractive: true,
    });
    const tool = agent.messages().find((message) => message.role === "tool");
    expect(tool?.isError).toBe(true);
    expect(tool?.text).toContain("denied");
  });

  it("does not inherit the full-access preset into a subagent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-full-access-subagent-"));
    const prevCwd = process.cwd();
    const prevHome = process.env.HOME;
    process.chdir(dir);
    process.env.HOME = dir;
    try {
      await mkdir(join(dir, ".thebe", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".thebe", "agents", "worker.md"),
        "---\nname: worker\ndescription: Worker\n---\nDo the work.\n"
      );
      const fake = createFakeRuntime();
      const handlers: Array<
        NonNullable<
          Parameters<typeof fake.runtime.createSession>[0]["permissionHandler"]
        >
      > = [];
      const agent = createThebeAgent({
        runtime: {
          ...fake.runtime,
          async createSession(options) {
            if (options.permissionHandler)
              handlers.push(options.permissionHandler);
            return fake.runtime.createSession(options);
          },
        },
        provider: emptyProvider(),
        fullAccessAllowed: true,
      });
      const parent = await agent.createSession();
      await agent.setSessionFullAccess(parent.thebeSessionId, true);
      fake.queueTurns([{ kind: "text", text: "child done" }]);
      const run = await agent.spawnSubagent({
        profileName: "worker",
        taskPrompt: "do the work",
        parentSessionId: parent.thebeSessionId,
      });
      await agent.waitSubagent(run.runId);
      const childHandler = handlers[handlers.length - 1]!;
      const request = {
        permissionId: "p",
        toolCallId: "c",
        toolName: "bash",
        args: { command: "ls" },
      };
      expect(await handlers[0]!.preflight!(request)).toBe("allow");
      expect(await childHandler.preflight!(request)).toBe("ask");
    } finally {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("lists skills, mcp tools, subagent profiles, spawn, and fork messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-agent-features-"));
    const prevCwd = process.cwd();
    const prevHome = process.env.HOME;
    process.chdir(dir);
    process.env.HOME = dir;
    try {
      await mkdir(join(dir, ".thebe", "skills", "demo"), { recursive: true });
      await writeFile(
        join(dir, ".thebe", "skills", "demo", "SKILL.md"),
        "---\nname: demo-skill\ndescription: Demo skill\n---\nDo the demo.\n"
      );
      await mkdir(join(dir, ".thebe", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".thebe", "agents", "researcher.md"),
        "---\nname: researcher\ndescription: Research helper\n---\nYou research.\n"
      );
      await writeFile(
        join(dir, ".thebe", "mcp.json"),
        JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } })
      );

      const fake = createFakeRuntime();
      fake.queueTurns([
        { kind: "text", text: "parent-ok" },
        { kind: "text", text: "child-ok" },
      ]);
      const agent = createThebeAgent({
        runtime: fake.runtime,
        provider: emptyProvider(),
        workspacePath: dir,
        mcp: createMcpClientRegistry({ cwd: dir, homeDir: dir }),
      });
      const parent = await agent.createSession({ title: "parent" });
      await agent.prompt("parent-turn", {
        thebeSessionId: parent.thebeSessionId,
      });

      const skills = await agent.listSkills();
      expect(skills.map((skill) => skill.name)).toContain("demo-skill");
      await agent.enableSkill("demo-skill");
      expect((await agent.getSkill("demo-skill"))?.enabled).toBe(true);
      expect(fake.snapshot(parent.runtimeSessionId).resourceReloads).toBe(1);
      expect(fake.snapshot(parent.runtimeSessionId).enabledResources).toEqual([
        expect.objectContaining({
          kind: "skill",
          identity: "demo-skill",
        }),
      ]);
      await agent.disableSkill("demo-skill");
      expect((await agent.getSkill("demo-skill"))?.enabled).toBe(false);

      const tools = await agent.listMcpTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["container.list", "list_core_events"])
      );
      const servers = await agent.listMcpServers();
      expect(servers.map((server) => server.name)).toContain("notes");

      const profiles = await agent.listSubagentProfiles();
      expect(profiles.map((profile) => profile.name)).toContain("researcher");
      expect(profiles.map((profile) => profile.name)).toContain("diagnostics");
      const child = await agent.spawnSubagent({
        profileName: "researcher",
        taskPrompt: "do research",
        parentSessionId: parent.thebeSessionId,
      });
      expect(child.parentSessionId).toBe(parent.thebeSessionId);
      expect(child.status).toMatch(/queued|running/);
      const childUpdates: Array<{ event?: { type: string } }> = [];
      const unsubscribeChild = agent.subscribeSubagent(
        child.runId,
        (update) => {
          childUpdates.push(update);
        }
      );
      const completed = await agent.waitSubagent(child.runId);
      unsubscribeChild();
      expect(completed.status).toBe("completed");
      expect(completed.result).toBe("child-ok");
      expect(
        childUpdates.some((update) => update.event?.type === "text_delta")
      ).toBe(true);
      const listed = await agent.listSubagents(parent.thebeSessionId);
      expect(
        listed.some(
          (row) =>
            row.runId === child.runId &&
            row.parentSessionId === parent.thebeSessionId
        )
      ).toBe(true);
      expect(await agent.listSessions()).toHaveLength(1);
      expect(await fake.runtime.listSessions()).toHaveLength(1);

      const forks = await agent.getForkMessages(parent.thebeSessionId);
      expect(forks.some((turn) => turn.text.includes("parent-turn"))).toBe(
        true
      );
    } finally {
      process.chdir(prevCwd);
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  it("cancels one-shot subagents and keeps the parent as the only session", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const parent = await agent.createSession({ title: "parent" });
    const run = await agent.spawnSubagent({
      profileName: "diagnostics",
      taskPrompt: "inspect the services",
      parentSessionId: parent.thebeSessionId,
    });

    await vi.waitFor(() => {
      expect(agent.getSubagent(run.runId)?.status).toBe("running");
    });
    await agent.cancelSubagent(run.runId, parent.thebeSessionId);
    await expect(agent.waitSubagent(run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(await agent.listSessions()).toHaveLength(1);
    expect(await fake.runtime.listSessions()).toHaveLength(1);
    expect(agent.messages()).toEqual([]);
  });

  it("retains a bounded child progress trace and streamed response for later inspection", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "text",
        thinking: "checking the requested files",
        text: "child final response",
      },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const parent = await agent.createSession({ title: "parent" });
    const run = await agent.spawnSubagent({
      profileName: "diagnostics",
      taskPrompt: "Inspect the exact child task",
      parentSessionId: parent.thebeSessionId,
    });

    const completed = await agent.waitSubagent(run.runId);

    expect(completed).toMatchObject({
      task: "Inspect the exact child task",
      responseText: "child final response",
    });
    expect(completed.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "thinking" }),
        expect.objectContaining({ kind: "response" }),
        expect.objectContaining({ kind: "status", title: "completed" }),
      ])
    );
  });

  it("queues subagents by concurrency without sharing parent state", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "hang" },
      { kind: "text", text: "second-result" },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: emptyProvider(),
      maxSubagentConcurrency: 1,
      maxSubagentsPerParent: 1,
    });
    const parent = await agent.createSession({ title: "parent" });
    const first = await agent.spawnSubagent({
      profileName: "diagnostics",
      taskPrompt: "first task",
      parentSessionId: parent.thebeSessionId,
    });
    const second = await agent.spawnSubagent({
      profileName: "diagnostics",
      taskPrompt: "second task",
      parentSessionId: parent.thebeSessionId,
    });

    await vi.waitFor(() => {
      expect(agent.getSubagent(first.runId)?.status).toBe("running");
      expect(agent.getSubagent(second.runId)?.status).toBe("queued");
    });
    await agent.cancelSubagent(first.runId, parent.thebeSessionId);
    await expect(agent.waitSubagent(first.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(agent.waitSubagent(second.runId)).resolves.toMatchObject({
      status: "completed",
      result: "second-result",
    });
    expect(await agent.listSessions()).toHaveLength(1);
  });

  it("does not inherit context and enforces the profile turn limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-ephemeral-subagent-"));
    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    process.chdir(dir);
    process.env.HOME = dir;
    try {
      await mkdir(join(dir, ".thebe", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".thebe", "agents", "limited.md"),
        "---\nname: limited\ndescription: One turn\nmaxTurns: 1\ninheritContext: true\ntools: [container.list]\n---\nDo one diagnostic turn.\n"
      );
      const fake = createFakeRuntime();
      fake.queueTurns([
        { kind: "text", text: "parent-secret" },
        { kind: "tools", calls: [{ name: "container.list" }] },
        { kind: "text", text: "must-not-run" },
      ]);
      const createCalls: Array<
        Parameters<typeof fake.runtime.createSession>[0]
      > = [];
      const runtime = {
        ...fake.runtime,
        async createSession(
          create: Parameters<typeof fake.runtime.createSession>[0]
        ) {
          createCalls.push(create);
          return fake.runtime.createSession(create);
        },
      };
      const agent = createThebeAgent({
        runtime,
        provider: emptyProvider(),
        workspacePath: dir,
      });
      const parent = await agent.createSession({ title: "parent" });
      await agent.prompt("parent task", {
        thebeSessionId: parent.thebeSessionId,
      });
      const run = await agent.spawnSubagent({
        profileName: "limited",
        taskPrompt: "child task only",
        parentSessionId: parent.thebeSessionId,
      });
      const completed = await agent.waitSubagent(run.runId);

      expect(completed).toMatchObject({
        status: "failed",
        turns: 1,
        maxTurns: 1,
      });
      expect(completed.result).toBe("");
      expect(completed.error).toContain("turn limit");
      const childCreate = createCalls.at(-1)!;
      expect(childCreate.inMemory).toBe(true);
      expect(childCreate.builtinTools).toEqual(["container.list"]);
      expect(childCreate.systemPrompt).not.toContain("parent-secret");
      expect(agent.messages().map((message) => message.text)).toEqual([
        "parent task",
        "parent-secret",
      ]);
      expect(await agent.listSessions()).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
