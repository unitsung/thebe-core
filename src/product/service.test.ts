import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../providers/index.ts";
import { createFakeRuntime } from "../runtime/fake-runtime.ts";
import { createThebeApp } from "./app.ts";
import { hashParameters } from "../audit/audit-log.ts";
import {
  createThebeProduct,
  DEFAULT_AUTO_SUMMARY_DELAY_MS,
} from "./service.ts";

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

describe("Thebe product service (fake runtime)", () => {
  it("uses a two-minute idle default for automatic summaries", () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });

    expect(DEFAULT_AUTO_SUMMARY_DELAY_MS).toBe(120_000);
    expect(product.autoSummaryDelayMs()).toBe(120_000);
  });

  it("asks through Thebe-owned events, not Pi event types", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const result = await product.send("ping");
    expect(result.text).toBe("pong");
    expect(result.events.map((event) => event.type)).toEqual([
      "text_delta",
      "turn_end",
      "session_end",
    ]);
    expect(JSON.stringify(result.events)).not.toContain("message_update");
    expect(JSON.stringify(result.events)).not.toContain("assistantMessageEvent");
  });

  it("registers Pi built-ins together with container tools", () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    expect(product.toolNames()).toEqual(
      expect.arrayContaining([
        "ls",
        "bash",
        "read",
        "edit",
        "write",
        "container.list",
        "container.inspect",
      ]),
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
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider,
    });
    const result = await product.send("inspect");
    expect(result.text).toBe("inspected");
    const dumped = JSON.stringify({
      events: result.events,
      messages: product.messages(),
    });
    expect(dumped).not.toContain(CANARY);
    expect(dumped).toContain("***REDACTED***");
  });

  it("HTTP session prompt and TUI share the product from createThebeApp", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "shared" }]);
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: emptyProvider(),
      version: "0.1.0",
    });
    const created = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
    );
    const session = (await created.json()) as { thebeSessionId: string };
    const http = await app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello" }),
        },
      ),
    );
    expect(http.status).toBe(200);
    await expect(http.json()).resolves.toMatchObject({
      text: "shared",
      tools: [],
      thebeSessionId: session.thebeSessionId,
    });
    expect(app.send).toBeTypeOf("function");
  });

  it("ProductStore files contain mapping keys only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-meta-"));
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "ok" }]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
      productStoreDir: dir,
    });
    await product.send("hi");
    const listed = await product.listSessions();
    expect(listed).toHaveLength(1);
    const raw = await readFile(
      join(dir, `${listed[0]!.thebeSessionId}.json`),
      "utf8",
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
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await product.send("one");
    const parentId = product.lastThebeSessionId()!;
    const before = product.messages().map((message) => message.text);
    await product.fork(parentId);
    const parent = fake.snapshot(
      (await product.listSessions()).find((row) => row.thebeSessionId === parentId)!
        .runtimeSessionId,
    );
    expect(parent.messages.map((message) => message.text)).toEqual(before);
  });

  it("compact then continue", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await product.send("one");
    await product.compact();
    const continued = await product.send("two");
    expect(continued.text).toBe("second");
    expect(fake.compactCalls()).toBe(1);
  });

  it("deletes both the Thebe mapping and the underlying runtime session", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider: emptyProvider() });
    const meta = await product.createSession({ title: "delete-me" });

    await product.deleteSession(meta.thebeSessionId);

    await expect(product.getSession(meta.thebeSessionId)).rejects.toThrow();
    expect(await fake.runtime.listSessions()).not.toContainEqual({
      runtimeSessionId: meta.runtimeSessionId,
    });
  });

  it("passes compact instructions and toggles official auto-compact", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "first" }]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const meta = await product.createSession();
    const before = await product.getContextUsage(meta.thebeSessionId);
    expect(before.compaction.enabled).toBe(true);
    await product.send("one");
    await product.compact(meta.thebeSessionId, "keep the API decisions");
    expect(fake.compactCalls()).toBe(1);
    expect(fake.compactInstructions()).toEqual(["keep the API decisions"]);
    const after = await product.getContextUsage(meta.thebeSessionId);
    expect(after.compaction.lastCompactedAt).toBeDefined();
    await product.setAutoCompactionEnabled(meta.thebeSessionId, false);
    const disabled = await product.getContextUsage(meta.thebeSessionId);
    expect(disabled.compaction.enabled).toBe(false);
    expect(disabled.compaction.nearThreshold).toBe(false);
  });

  it("generates and persists an automatic summary after idle time", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeRuntime();
      fake.queueTurns([{ kind: "text", text: "completed" }]);
      const product = createThebeProduct({
        runtime: fake.runtime,
        provider: emptyProvider(),
        autoSummaryDelayMs: 60_000,
      });
      const result = await product.send("finish the task");
      const events: string[] = [];
      product.subscribeLog(result.thebeSessionId, (event) => {
        events.push(event.type);
      });

      await vi.advanceTimersByTimeAsync(60_000);

      const meta = await product.getSession(result.thebeSessionId);
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
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
      auditPath,
    });
    expect(product.enabledResources()).toEqual([]);
    await product.enableResource({
      kind: "skill",
      identity: "homelab-status",
      version: "1.0.0",
      source: "thebe://skills/homelab-status",
    });
    const row = JSON.parse(
      (await readFile(auditPath, "utf8")).trim(),
    ) as Record<string, unknown>;
    expect(row).toMatchObject({
      method: "resource.enable",
      identity: "homelab-status",
      version: "1.0.0",
      source: "thebe://skills/homelab-status",
    });
    expect(product.enabledResources()).toHaveLength(1);
  });

  it("MCP tools/call uses the same product invokeTool path", async () => {
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
      }),
    );
    const body = (await res.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(body.result?.content?.[0]?.text).toContain("runningContainers");
  });

  it("prompt accepts files and records them on the user message", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "saw-file" }]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const result = await product.prompt({
      text: "look",
      files: [
        { mediaType: "image/png", data: "aaaa", filename: "shot.png" },
      ],
    });
    expect(result.text).toBe("saw-file");
    expect(product.messages()[0]?.text).toContain("shot.png");
    expect(product.messages()[0]?.text).toContain("image/png");
  });

  it("forks from a specific message id", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await product.prompt("one");
    const firstAssistant = product.messages()[1]!;
    await product.prompt("two");
    const parentId = product.lastThebeSessionId()!;
    const child = await product.fork(parentId, firstAssistant.id);
    expect(child.parentThebeSessionId).toBe(parentId);
    expect(product.messages().map((message) => message.text)).toEqual([
      "one",
      "first",
    ]);
    const kids = await product.children(parentId);
    expect(kids.map((row) => row.thebeSessionId)).toEqual([child.thebeSessionId]);
  });

  it("reverts and unreverts the last user turn", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    await product.prompt("ping");
    await product.revert();
    expect(product.messages()).toEqual([]);
    await product.unrevert();
    expect(product.messages().map((message) => message.text)).toEqual([
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
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const pending = product.prompt("run bash");
    await vi.waitFor(() => {
      expect(product.pendingPermissionIds().length).toBe(1);
    });
    const permissionId = product.pendingPermissionIds()[0]!;
    const sessionId = product.lastThebeSessionId()!;
    expect(product.lastEvents().some((event) => event.type === "permission_requested")).toBe(
      true,
    );
    await product.resolvePermission(sessionId, permissionId, {
      response: "deny",
    });
    const result = await pending;
    expect(result.text).toBe("after");
    const tool = product.messages().find((message) => message.role === "tool");
    expect(tool?.isError).toBe(true);
    expect(tool?.text).toContain("denied");
  });

  it("remember:true persists the approval decision on the session meta", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const pending = product.prompt("run bash");
    await vi.waitFor(() => {
      expect(product.pendingPermissionIds().length).toBe(1);
    });
    const permissionId = product.pendingPermissionIds()[0]!;
    const sessionId = product.lastThebeSessionId()!;
    await product.resolvePermission(sessionId, permissionId, {
      response: "allow",
      remember: true,
    });
    await pending;
    const meta = await product.getSession(sessionId);
    expect(meta.rememberedPermissions?.bash).toBeUndefined();
    expect(
      meta.rememberedPermissions?.[`bash:${hashParameters({ command: "ls" })}`],
    ).toBe("allow");
  });

  it("re-reads rememberedPermissions at tool dispatch so a later deny sticks", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const sessionId = (await product.createSession()).thebeSessionId;
    await product.patchSession(sessionId, {
      rememberedPermissions: { bash: "deny" },
    });
    const result = await product.prompt("run bash", { thebeSessionId: sessionId });
    expect(result.text).toBe("after");
    expect(product.pendingPermissionIds()).toHaveLength(0);
    const tool = product.messages().find((message) => message.role === "tool");
    expect(tool?.isError).toBe(true);
    expect(tool?.text).toContain("denied");
  });

  it("full-access auto-approves approval-gated tools while explicit deny wins", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
      permissionMode: "full-access",
    });
    const result = await product.send("run bash");
    expect(result.text).toBe("after");
    expect(product.permissionMode()).toBe("full-access");
    expect(product.pendingPermissionIds()).toHaveLength(0);

    const denied = createFakeRuntime();
    denied.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "denied after" },
    ]);
    const guarded = createThebeProduct({
      runtime: denied.runtime,
      provider: emptyProvider(),
      permissionMode: "full-access",
    });
    const session = await guarded.createSession();
    await guarded.patchSession(session.thebeSessionId, {
      rememberedPermissions: { bash: "deny" },
    });
    await guarded.prompt("run bash", { thebeSessionId: session.thebeSessionId });
    expect(guarded.messages().find((message) => message.role === "tool")?.isError).toBe(true);
  });

  it("read-only mode denies approval-gated tools without opening a permission prompt", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "read-only" },
    ]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
      permissionMode: "read-only",
    });
    const result = await product.send("run bash");
    expect(result.text).toBe("read-only");
    expect(product.permissionMode()).toBe("read-only");
    expect(product.pendingPermissionIds()).toHaveLength(0);
  });

  it("lists skills, mcp tools, subagent profiles, spawn, and fork messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-product-features-"));
    const prevCwd = process.cwd();
    const prevHome = process.env.HOME;
    process.chdir(dir);
    process.env.HOME = dir;
    try {
      await mkdir(join(dir, ".thebe", "skills", "demo"), { recursive: true });
      await writeFile(
        join(dir, ".thebe", "skills", "demo", "SKILL.md"),
        "---\nname: demo-skill\ndescription: Demo skill\n---\nDo the demo.\n",
      );
      await mkdir(join(dir, ".thebe", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".thebe", "agents", "researcher.md"),
        "---\nname: researcher\ndescription: Research helper\n---\nYou research.\n",
      );
      await writeFile(
        join(dir, ".thebe", "mcp.json"),
        JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } }),
      );

      const fake = createFakeRuntime();
      fake.queueTurns([
        { kind: "text", text: "parent-ok" },
        { kind: "text", text: "child-ok" },
      ]);
      const product = createThebeProduct({
        runtime: fake.runtime,
        provider: emptyProvider(),
      });
      const parent = await product.createSession({ title: "parent" });
      await product.prompt("parent-turn", {
        thebeSessionId: parent.thebeSessionId,
      });

      const skills = await product.listSkills();
      expect(skills.map((skill) => skill.name)).toContain("demo-skill");
      await product.enableSkill("demo-skill");
      expect((await product.getSkill("demo-skill"))?.enabled).toBe(true);
      expect(fake.snapshot(parent.runtimeSessionId).resourceReloads).toBe(1);
      expect(fake.snapshot(parent.runtimeSessionId).enabledResources).toEqual([
        expect.objectContaining({
          kind: "skill",
          identity: "demo-skill",
        }),
      ]);
      await product.disableSkill("demo-skill");
      expect((await product.getSkill("demo-skill"))?.enabled).toBe(false);

      const tools = await product.listMcpTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["container.list", "list_core_events"]),
      );
      const servers = await product.listMcpServers();
      expect(servers.map((server) => server.name)).toContain("notes");

      const profiles = await product.listSubagentProfiles();
      expect(profiles.map((profile) => profile.name)).toContain("researcher");
      expect(profiles.map((profile) => profile.name)).toContain("diagnostics");
      const child = await product.spawnSubagent({
        profileName: "researcher",
        taskPrompt: "do research",
        parentSessionId: parent.thebeSessionId,
      });
      expect(child.parentSessionId).toBe(parent.thebeSessionId);
      expect(child.status).toMatch(/queued|running/);
      const completed = await product.waitSubagent(child.runId);
      expect(completed.status).toBe("completed");
      expect(completed.result).toBe("child-ok");
      const listed = await product.listSubagents(parent.thebeSessionId);
      expect(
        listed.some(
          (row) =>
            row.runId === child.runId &&
            row.parentSessionId === parent.thebeSessionId,
        ),
      ).toBe(true);
      expect(await product.listSessions()).toHaveLength(1);
      expect(await fake.runtime.listSessions()).toHaveLength(1);

      const forks = await product.getForkMessages(parent.thebeSessionId);
      expect(forks.some((turn) => turn.text.includes("parent-turn"))).toBe(
        true,
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
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
    });
    const parent = await product.createSession({ title: "parent" });
    const run = await product.spawnSubagent({
      profileName: "diagnostics",
      taskPrompt: "inspect the services",
      parentSessionId: parent.thebeSessionId,
    });

    await vi.waitFor(() => {
      expect(product.getSubagent(run.runId)?.status).toBe("running");
    });
    await product.cancelSubagent(run.runId, parent.thebeSessionId);
    await expect(product.waitSubagent(run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(await product.listSessions()).toHaveLength(1);
    expect(await fake.runtime.listSessions()).toHaveLength(1);
    expect(product.messages()).toEqual([]);
  });

  it("queues subagents by concurrency without sharing parent state", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "hang" },
      { kind: "text", text: "second-result" },
    ]);
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: emptyProvider(),
      maxSubagentConcurrency: 1,
      maxSubagentsPerParent: 1,
    });
    const parent = await product.createSession({ title: "parent" });
    const first = await product.spawnSubagent({
      profileName: "diagnostics",
      taskPrompt: "first task",
      parentSessionId: parent.thebeSessionId,
    });
    const second = await product.spawnSubagent({
      profileName: "diagnostics",
      taskPrompt: "second task",
      parentSessionId: parent.thebeSessionId,
    });

    await vi.waitFor(() => {
      expect(product.getSubagent(first.runId)?.status).toBe("running");
      expect(product.getSubagent(second.runId)?.status).toBe("queued");
    });
    await product.cancelSubagent(first.runId, parent.thebeSessionId);
    await expect(product.waitSubagent(first.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(product.waitSubagent(second.runId)).resolves.toMatchObject({
      status: "completed",
      result: "second-result",
    });
    expect(await product.listSessions()).toHaveLength(1);
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
        "---\nname: limited\ndescription: One turn\nmaxTurns: 1\ninheritContext: true\ntools: [container.list]\n---\nDo one diagnostic turn.\n",
      );
      const fake = createFakeRuntime();
      fake.queueTurns([
        { kind: "text", text: "parent-secret" },
        { kind: "tools", calls: [{ name: "container.list" }] },
        { kind: "text", text: "must-not-run" },
      ]);
      const createCalls: Array<Parameters<typeof fake.runtime.createSession>[0]> = [];
      const runtime = {
        ...fake.runtime,
        async createSession(
          create: Parameters<typeof fake.runtime.createSession>[0],
        ) {
          createCalls.push(create);
          return fake.runtime.createSession(create);
        },
      };
      const product = createThebeProduct({
        runtime,
        provider: emptyProvider(),
      });
      const parent = await product.createSession({ title: "parent" });
      await product.prompt("parent task", { thebeSessionId: parent.thebeSessionId });
      const run = await product.spawnSubagent({
        profileName: "limited",
        taskPrompt: "child task only",
        parentSessionId: parent.thebeSessionId,
      });
      const completed = await product.waitSubagent(run.runId);

      expect(completed).toMatchObject({
        status: "completed",
        turns: 1,
        maxTurns: 1,
      });
      expect(completed.result).toBe("");
      expect(completed.error).toContain("turn limit");
      const childCreate = createCalls.at(-1)!;
      expect(childCreate.inMemory).toBe(true);
      expect(childCreate.builtinTools).toEqual(["container.list"]);
      expect(childCreate.systemPrompt).not.toContain("parent-secret");
      expect(product.messages().map((message) => message.text)).toEqual([
        "parent task",
        "parent-secret",
      ]);
      expect(await product.listSessions()).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
