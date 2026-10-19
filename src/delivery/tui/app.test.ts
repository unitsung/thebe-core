import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  Markdown,
  Text,
  TuiMainScreen,
  type Terminal,
  type TUI,
} from "./rendering/adapter.ts";
import { createThebeAgent } from "../../agent/index.ts";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import {
  createFakeRuntime,
  FAKE_RUNTIME_MODELS,
} from "../../testing/runtime/index.ts";
import {
  attachThebeChat,
  copyToClipboard,
  formatCwd,
  formatTokens,
  renderStartScreen,
  resolveSlashName,
  SLASH_COMMANDS,
} from "./app.ts";
import { SearchableModelPicker } from "./overlays/model-picker.ts";
import {
  defaultMarkdownTheme,
  getBashModeBorderColor,
  getTuiTheme,
  lightMarkdownTheme,
} from "./theme.ts";
import { attachModalSelectList } from "./overlays/index.ts";
import { showTaskPane } from "./overlays/task-pane.ts";

class MemoryTerminal implements Terminal {
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  get columns(): number {
    return 80;
  }
  get rows(): number {
    return 24;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

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

describe("Thebe TUI (@earendil-works/pi-tui chat-simple)", () => {
  it("keeps the startup screen compact and action-oriented", () => {
    const plain = renderStartScreen({
      version: "0.1.0",
      model: "opencode/muse-spark-1.3-free",
      cwd: "/workspace/thebe-core",
      branch: "dev",
      width: 120,
    }).replace(/\x1b\[[0-9;]*m/g, "");

    expect(plain.split("\n").length).toBeLessThanOrEqual(10);
    expect(plain).toContain("/ commands");
    expect(plain).toContain("Ctrl+O tools");
    expect(plain).not.toContain("Quick Start:");
    expect(plain).not.toContain("Try Asking:");
  });

  it("renders markdown with pi-tui's default theme", () => {
    const md = new Markdown(
      "# Status\n\n**25 running** and `nginx`\n\n- one\n- two",
      1,
      1,
      defaultMarkdownTheme
    );
    const joined = md.render(40).join("\n");
    expect(joined).toContain("Status");
    expect(joined).toContain("25 running");
    expect(joined).not.toContain("**25 running**");
    expect(joined).not.toContain("# Status");
    expect(joined).toContain("\x1b[");
  });

  it("does not persist an empty session until the first prompt", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "created lazily" }]);
    const dir = await mkdtemp(join(tmpdir(), "thebe-lazy-tui-"));
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider,
      agentStoreDir: dir,
    });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, { agent });

    expect(await agent.listSessions()).toHaveLength(0);
    editor.onSubmit?.("first prompt");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await agent.listSessions()).toHaveLength(1);
    expect(tui.children.some((child) => child instanceof Markdown)).toBe(true);
  });

  it("splices the reply before the Editor, like chat-simple", async () => {
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      send: async () => "**25 running**",
    });
    editor.onSubmit?.("hello");
    await new Promise((r) => setTimeout(r, 40));
    const markdown = tui.children.filter((child) => child instanceof Markdown);
    expect(markdown).toHaveLength(2);
    expect(markdown[0]!.render(40).join("\n")).toContain("hello");
    const reply = markdown[1]!.render(40).join("\n");
    expect(reply).toContain("25 running");
    expect(reply).not.toContain("**25 running**");
    expect(tui.children.at(-1)?.constructor.name).toBe("FooterDock");
    expect(tui.children.at(-2)?.constructor.name).toBe("Editor");
    expect(
      tui.children.some((child) => child.constructor.name === "Loader")
    ).toBe(false);
  });

  it("opens Goal and subagent progress from their keyboard shortcuts", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }, { kind: "hang" }]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const parent = await agent.createSession({ title: "shortcut-test" });
    const child = await agent.spawnSubagent({
      profileName: "diagnostics",
      taskPrompt: "inspect the current services",
      parentSessionId: parent.thebeSessionId,
    });
    await vi.waitFor(() => {
      expect(agent.getSubagent(child.runId)?.status).toBe("running");
    });
    await agent.startGoal({
      thebeSessionId: parent.thebeSessionId,
      goal: "verify the shortcut flow",
      maxIterations: 2,
    });

    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      agent,
      sessionId: parent.thebeSessionId,
    });
    const footer = tui.children.at(-1) as {
      render: (width: number) => string[];
    };
    expect(footer.render(100).join("\n")).toContain("Tasks");
    expect(footer.render(100).join("\n")).toContain("click/Ctrl+G open");

    editor.handleInput("\x07");
    await vi.waitFor(() => {
      expect(tui.hasOverlay()).toBe(true);
    });

    editor.handleInput("\x07");
    expect(tui.hasOverlay()).toBe(false);

    editor.handleInput("\x1b[103;6u");
    await vi.waitFor(() => {
      expect(tui.hasOverlay()).toBe(true);
    });

    await agent.stopGoal(parent.thebeSessionId);
    await agent.cancelSubagent(child.runId, parent.thebeSessionId);
  });

  it("keeps the task overlay mounted beneath a permission modal", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const parent = await agent.createSession({ title: "permission-overlay" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const closeTaskPane = showTaskPane(tui, agent, parent.thebeSessionId);

    expect(tui.hasOverlay()).toBe(true);
    const picker = attachModalSelectList(tui, [
      { label: "Deny", value: "deny" },
      { label: "Allow once", value: "allow" },
    ]);
    await vi.waitFor(() => {
      expect(tui.hasOverlay()).toBe(true);
    });

    // TUI dispatches input to the topmost modal overlay. Selecting it must
    // reveal the original Task pane instead of leaving the user at the chat.
    (
      tui as unknown as { handleTerminalInput: (data: string) => void }
    ).handleTerminalInput("\r");
    await expect(picker).resolves.toMatchObject({ value: "deny" });
    expect(tui.hasOverlay()).toBe(true);

    closeTaskPane();
    expect(tui.hasOverlay()).toBe(false);
  });

  it("does not close an open task pane when the parent requests permission", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "hang" }]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const parent = await agent.createSession({ title: "permission-task" });
    const child = await agent.spawnSubagent({
      profileName: "diagnostics",
      taskPrompt: "keep a task visible while the parent asks for approval",
      parentSessionId: parent.thebeSessionId,
    });
    await vi.waitFor(() => {
      expect(agent.getSubagent(child.runId)?.status).toBe("running");
    });

    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, dispose } = attachThebeChat(tui, {
      agent,
      sessionId: parent.thebeSessionId,
    });
    editor.handleInput("\x07");
    await vi.waitFor(() => {
      expect(tui.hasOverlay()).toBe(true);
    });

    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "pwd" } }] },
    ]);
    editor.onSubmit?.("run the command");
    await vi.waitFor(() => {
      expect(agent.pendingPermissionIds()).not.toHaveLength(0);
    });
    expect(tui.hasOverlay()).toBe(true);

    (
      tui as unknown as { handleTerminalInput: (data: string) => void }
    ).handleTerminalInput("\r");
    await vi.waitFor(() => {
      expect(agent.pendingPermissionIds()).toHaveLength(0);
    });
    expect(tui.hasOverlay()).toBe(true);

    dispose();
    await agent.cancelSubagent(child.runId, parent.thebeSessionId);
  });

  it("keeps the parent conversation visible while a goal runs in the background", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "hang" },
      { kind: "text", text: "parent continues normally" },
    ]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const parent = await agent.createSession({ title: "goal-continuation" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: parent.thebeSessionId,
    });

    await handleSlash("/goal finish the checkpoint");
    await vi.waitFor(() => {
      expect(agent.getGoal(parent.thebeSessionId)?.activeSubagent?.status).toBe(
        "running"
      );
    });
    expect(tui.hasOverlay()).toBe(false);

    editor.onSubmit?.("continue the parent conversation");
    await vi.waitFor(() => {
      const text = tui.children
        .filter((child) => child instanceof Text || child instanceof Markdown)
        .map((child) => child.render(120).join("\n"))
        .join("\n");
      expect(text).toContain("parent continues normally");
    });

    await agent.stopGoal(parent.thebeSessionId);
  });

  it("prints the verified goal conclusion into the parent transcript", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "checkpoint changed the workspace" },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: pnpm test — all tests pass\nREMAINING: none",
      },
    ]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const parent = await agent.createSession({ title: "goal-conclusion" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: parent.thebeSessionId,
    });

    await handleSlash("/goal finish the checkpoint");
    await vi.waitFor(() => {
      const text = tui.children
        .filter((child) => child instanceof Text || child instanceof Markdown)
        .map((child) => child.render(120).join("\n"))
        .join("\n");
      expect(text).toContain("Goal completed");
      expect(text).toContain("pnpm test");
      expect(text).toContain("VERDICT: pass");
    });
  });

  it("restores a saved Goal conclusion and child results when resuming", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "worker checkpoint result" },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: child artifact verified\nREMAINING: none",
      },
    ]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const goalSession = await agent.createSession({ title: "saved-goal" });
    await agent.startGoal({
      thebeSessionId: goalSession.thebeSessionId,
      goal: "Finish and verify the saved task",
      maxIterations: 2,
    });
    await expect(
      agent.waitGoal(goalSession.thebeSessionId)
    ).resolves.toMatchObject({
      status: "completed",
      finalReport: expect.stringContaining("child artifact verified"),
    });

    const otherSession = await agent.createSession({
      title: "current-session",
    });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash, editor } = attachThebeChat(tui, {
      agent,
      sessionId: otherSession.thebeSessionId,
    });

    await handleSlash(`/resume ${goalSession.thebeSessionId}`);

    const transcript = () =>
      tui.children
        .filter((child) => child instanceof Text || child instanceof Markdown)
        .map((child) => child.render(120).join("\n"))
        .join("\n");
    await vi.waitFor(() => {
      expect(transcript()).toContain("Goal completed");
      expect(transcript()).toContain("child artifact verified");
    });

    expect(tui.children.at(-1)?.render(120).join("\n")).toContain("Tasks");
    expect(
      (await agent.listSubagents(goalSession.thebeSessionId)).map(
        (run) => run.result
      )
    ).toEqual([
      "worker checkpoint result",
      "VERDICT: pass\nEVIDENCE: child artifact verified\nREMAINING: none",
    ]);
    editor.handleInput("\x07");
    await vi.waitFor(() => expect(tui.hasOverlay()).toBe(true));
  });

  it("waits for a busy parent response before appending the goal conclusion", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "hang" },
      { kind: "text", text: "checkpoint changed the workspace" },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: parent stayed responsive\nREMAINING: none",
      },
    ]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const parent = await agent.createSession({
      title: "goal-does-not-interrupt",
    });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: parent.thebeSessionId,
    });

    editor.onSubmit?.("keep answering this parent request");
    await vi.waitFor(() => {
      expect(agent.isBusy(parent.thebeSessionId)).toBe(true);
    });
    await handleSlash("/goal verify the background task");

    await vi.waitFor(() => {
      const text = tui.children
        .filter((child) => child instanceof Text || child instanceof Markdown)
        .map((child) => child.render(120).join("\n"))
        .join("\n");
      expect(text).not.toContain("Goal completed");
    });
    await agent.interrupt(parent.thebeSessionId);
    await vi.waitFor(() => {
      const text = tui.children
        .filter((child) => child instanceof Text || child instanceof Markdown)
        .map((child) => child.render(120).join("\n"))
        .join("\n");
      expect(text).toContain("Goal completed");
      expect(text).toContain("parent stayed responsive");
    });
  });

  it("clears messages with /clear and keeps the editor", () => {
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      send: async () => "unused",
    });
    tui.children.splice(
      tui.children.indexOf(editor),
      0,
      new Markdown("keep-me-not", 1, 1, defaultMarkdownTheme)
    );
    editor.onSubmit?.("/clear");
    expect(tui.children.some((child) => child instanceof Markdown)).toBe(false);
    expect(tui.children.at(-1)?.constructor.name).toBe("FooterDock");
    expect(tui.children.at(-2)?.constructor.name).toBe("Editor");
  });

  it("cancels an open picker when the transcript is cleared", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    const pickerPromise = handleSlash("/model");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      tui.children.some((child) => child instanceof SearchableModelPicker)
    ).toBe(true);

    await handleSlash("/clear");
    await expect(
      Promise.race([
        pickerPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("picker was not cancelled")), 100)
        ),
      ])
    ).resolves.toBe(true);
    expect(
      tui.children.some((child) => child instanceof SearchableModelPicker)
    ).toBe(false);
  });

  it("does not append a late history load after switching sessions", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const first = await agent.createSession({ title: "first" });
    const second = await agent.createSession({ title: "second" });

    fake.queueTurns([{ kind: "text", text: "first-session marker" }]);
    await agent.prompt("first request", {
      thebeSessionId: first.thebeSessionId,
    });
    fake.queueTurns([{ kind: "text", text: "second-session marker" }]);
    await agent.prompt("second request", {
      thebeSessionId: second.thebeSessionId,
    });

    const originalLoadMessages = agent.loadMessages.bind(agent);
    let releaseFirstLoad = () => {};
    const firstLoadGate = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    vi.spyOn(agent, "loadMessages").mockImplementation(async (id) => {
      const messages = await originalLoadMessages(id);
      if (id === first.thebeSessionId) {
        await firstLoadGate;
      }
      return messages;
    });

    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: first.thebeSessionId,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await handleSlash(`/tree ${second.thebeSessionId}`);
    const visible = () =>
      tui.children
        .filter(
          (child) =>
            typeof (child as { render?: unknown }).render === "function"
        )
        .map((child) =>
          (child as { render: (width: number) => string[] })
            .render(80)
            .join("\n")
        )
        .join("\n");
    expect(visible()).toContain("second-session marker");

    releaseFirstLoad();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(visible()).not.toContain("first-session marker");
  });
});

describe("Thebe TUI agent slash commands", () => {
  it("handles /session and /help via agent", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession({ title: "tui-demo" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    editor.onSubmit?.("/help");
    await new Promise((r) => setTimeout(r, 20));
    const helpText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(helpText).toContain("/compact");
    expect(helpText).not.toContain("[prompt]");
    expect(helpText).toContain("Session");
    expect(helpText).toContain("Agent");
    expect(helpText).toContain("Provider");
    expect(helpText).toContain("System");
    editor.onSubmit?.("/session");
    await new Promise((r) => setTimeout(r, 20));
    const sessionText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(sessionText).toContain(meta.thebeSessionId);
  });

  it("prompts through agent and shows reply", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "**ok**" }]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    editor.onSubmit?.("hello");
    await new Promise((r) => setTimeout(r, 60));
    const markdown = tui.children.filter((child) => child instanceof Markdown);
    expect(markdown.length).toBeGreaterThanOrEqual(2);
    const reply = markdown.at(-1)!.render(40).join("\n");
    expect(reply).toContain("ok");
  });

  it("renders assistant Markdown without leaking syntax markers", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "text",
        text: [
          "### Result",
          "",
          "**Done** and `pnpm test`.",
          "",
          "- first item",
          "- second item",
          "",
          "```ts",
          'const literal = "**not bold**";',
          "```",
        ].join("\n"),
      },
    ]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    editor.onSubmit?.("render markdown");
    await new Promise((r) => setTimeout(r, 80));

    const reply = tui.children
      .filter((child) => child instanceof Markdown)
      .at(-1)!;
    const rendered = reply.render(100).join("\n");
    const plainRendered = rendered.replace(/\x1b\[[0-9;]*m/g, "");
    expect(rendered).toContain("Result");
    expect(rendered).toContain("Done");
    expect(rendered).toContain("first item");
    expect(plainRendered).toContain('const literal = "**not bold**";');
    expect(plainRendered).not.toContain("### Result");
    expect(plainRendered).not.toContain("**Done**");
    expect(plainRendered).not.toContain("- first item");
    expect(plainRendered).not.toContain("```");
  });

  it("folds live thinking by default and expands it with Ctrl+T", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-thinking-default-"));
    const previousConfigDir = process.env.THEBE_CONFIG_DIR;
    process.env.THEBE_CONFIG_DIR = configDir;
    try {
      const fake = createFakeRuntime();
      fake.queueTurns([
        {
          kind: "text",
          thinking: "I am checking the relevant files first.",
          text: "done",
        },
      ]);
      const agent = createThebeAgent({ runtime: fake.runtime, provider });
      const meta = await agent.createSession();
      const tui: TUI = new TuiMainScreen(new MemoryTerminal());
      const chat = attachThebeChat(tui, {
        agent,
        sessionId: meta.thebeSessionId,
      });
      const { editor } = chat;

      editor.onSubmit?.("inspect");
      await new Promise((r) => setTimeout(r, 60));

      const transcript = tui.children
        .map((child) => child.render(80).join("\n"))
        .join("\n");
      expect(transcript).not.toContain(
        "I am checking the relevant files first."
      );

      chat.toggleThinking();
      const expanded = tui.children
        .map((child) => child.render(80).join("\n"))
        .join("\n");
      expect(expanded).toContain("◇");
      expect(expanded).toContain("I am checking the relevant files first.");
    } finally {
      if (previousConfigDir === undefined) delete process.env.THEBE_CONFIG_DIR;
      else process.env.THEBE_CONFIG_DIR = previousConfigDir;
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("shows tool calls and their results in the transcript", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      {
        kind: "tools",
        calls: [
          { name: "container.list", id: "call_container_list", args: {} },
        ],
      },
      { kind: "text", text: "after tool" },
    ]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    editor.onSubmit?.("list containers");
    await new Promise((r) => setTimeout(r, 80));

    const transcript = tui.children
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(transcript).toContain("container.list");
    expect(transcript).toContain("after tool");
  });

  it("keeps auto-summary as one faint footer line instead of transcript markdown", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    await new Promise((r) => setTimeout(r, 20));

    const before = tui.children.length;
    agent.emitLog(meta.thebeSessionId, {
      type: "summary_ready",
      summary: "已完成界面调整。\n\n重要文件和测试另见完整记录。",
      generatedAt: new Date().toISOString(),
    });

    expect(tui.children.length).toBe(before);
    expect(
      tui.children
        .filter((child) => child instanceof Markdown)
        .map((child) => child.render(80).join("\n"))
        .join("\n")
    ).not.toContain("Auto-summary");
    const footerLines = tui.children.at(-1)!.render(80);
    expect(footerLines).toHaveLength(3);
    expect(footerLines[0]).toContain("已完成界面调整。");
    expect(footerLines[0]).not.toContain("重要文件");
  });

  it("formats tokens and cwd helpers correctly", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(4500)).toBe("4.5k");
    expect(formatTokens(25000)).toBe("25k");
    expect(formatTokens(1500000)).toBe("1.5M");

    const home = process.env.HOME ?? "/test/home";
    expect(formatCwd(home)).toBe("~");
    expect(formatCwd(`${home}/projects/thebe`)).toBe("~/projects/thebe");
  });

  it("supports /model, /thinking, /theme, /hotkeys, and /tree", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    // /model
    await handleSlash("/model fake/fake-2");
    // /thinking
    await handleSlash("/thinking high");
    // /theme
    await handleSlash("/theme light");
    await handleSlash("/theme dark");
    // /hotkeys
    await handleSlash("/hotkeys");
    // /tree <id> switches directly without a hanging selector
    await handleSlash(`/tree ${meta.thebeSessionId}`);

    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");

    expect(allText).toContain("Ctrl+P");
    expect(allText).toContain("Alt+Enter");
    expect(allText).toContain("switched to branch");
    expect(allText).toContain(meta.thebeSessionId.slice(0, 8));
    const footer = tui.children.at(-1) as {
      render: (width: number) => string[];
    };
    const footerText = footer.render(80).join("\n");
    expect(footerText).toContain("fake-2 • thinking off");
  });

  it("switches permission modes from the command menu and persists the choice", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-permissions-"));
    const previousConfigDir = process.env.THEBE_CONFIG_DIR;
    process.env.THEBE_CONFIG_DIR = configDir;
    try {
      const fake = createFakeRuntime();
      const agent = createThebeAgent({ runtime: fake.runtime, provider });
      const tui: TUI = new TuiMainScreen(new MemoryTerminal());
      const { handleSlash } = attachThebeChat(tui, { agent });

      await handleSlash("/permissions plan");
      expect(agent.permissionMode()).toBe("plan");
      await handleSlash("/permissions acceptEdits");
      expect(agent.permissionMode()).toBe("acceptEdits");
      await handleSlash("/permissions manual");
      expect(agent.permissionMode()).toBe("manual");
      const bypassPromise = handleSlash("/permissions bypassPermissions");
      await vi.waitFor(() => {
        expect(
          tui.children.some((child) => child.constructor.name === "SelectList")
        ).toBe(true);
      });
      const list = tui.children.find(
        (child) => child.constructor.name === "SelectList"
      ) as {
        handleInput: (data: string) => void;
        render: (width: number) => string[];
      };
      expect(list.render(80).join("\n")).toContain("Turn on bypassPermissions");
      list.handleInput("\x1b");
      await bypassPromise;
      expect(agent.permissionMode()).toBe("manual");
      const confirmPromise = handleSlash("/permissions bypassPermissions");
      await vi.waitFor(() => {
        expect(
          tui.children.some((child) => child.constructor.name === "SelectList")
        ).toBe(true);
      });
      const confirm = tui.children.find(
        (child) => child.constructor.name === "SelectList"
      ) as { handleInput: (data: string) => void };
      confirm.handleInput("\x1b[B");
      confirm.handleInput("\r");
      await confirmPromise;
      expect(agent.permissionMode()).toBe("bypassPermissions");
    } finally {
      if (previousConfigDir === undefined) delete process.env.THEBE_CONFIG_DIR;
      else process.env.THEBE_CONFIG_DIR = previousConfigDir;
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("handles /copy when no assistant response vs with assistant response", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    await handleSlash("/copy");
    let allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("no assistant response found to copy");

    fake.queueTurns([
      { kind: "text", text: "Generated assistant response for copy" },
    ]);
    await agent.prompt("hello", { thebeSessionId: meta.thebeSessionId });
    await handleSlash("/copy");

    allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toMatch(
      /copied last response|clipboard command unavailable/
    );
  });

  it("registers slash commands in OpenCode Session/Agent/Provider/System groups", () => {
    const byCategory = (category: string) =>
      SLASH_COMMANDS.filter((c) => c.category === category).map((c) => c.name);
    expect(byCategory("Session")).toEqual(
      expect.arrayContaining([
        "resume",
        "new",
        "session",
        "summary",
        "history",
        "compact",
        "copy",
        "fork",
        "revert",
        "delete",
      ])
    );
    expect(byCategory("Agent")).toEqual(
      expect.arrayContaining(["model", "thinking", "agents"])
    );
    expect(byCategory("Provider")).toEqual(
      expect.arrayContaining(["login", "logout"])
    );
    expect(byCategory("System")).toEqual(
      expect.arrayContaining(["help", "quit", "settings", "hotkeys"])
    );
    expect(byCategory("Thebe")).toEqual(
      expect.arrayContaining(["skills", "mcp", "subagent"])
    );
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain("theme");
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain("tui");
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("history");
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("delete");
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain("provider");
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain("custom");
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain("usage");
    expect(resolveSlashName("models")).toBe("model");
    expect(resolveSlashName("connect")).toBe("login");
    expect(resolveSlashName("themes")).toBe("theme");
    expect(resolveSlashName("undo")).toBe("revert");
    expect(resolveSlashName("exit")).toBe("quit");
    expect(resolveSlashName("sessions")).toBe("resume");
    expect(resolveSlashName("continue")).toBe("resume");
    expect(resolveSlashName("message")).toBe("history");
    expect(resolveSlashName("messages")).toBe("history");
    expect(resolveSlashName("session")).toBe("session");
    expect(resolveSlashName("usage")).toBe("session");
    expect(resolveSlashName("status")).toBe("session");
    expect(resolveSlashName("agent")).toBe("agents");
    expect(resolveSlashName("skill")).toBe("skills");
    expect(resolveSlashName("subagents")).toBe("subagent");
  });

  it("handles /usage displaying context, token stats, turns, and cache hit rate", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession({ title: "usage-session" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    await handleSlash("/usage");
    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");

    expect(allText).toContain("Token & Usage Details");
    expect(allText).toContain(meta.thebeSessionId);
    expect(allText).toContain("Context Bar:");
    expect(allText).toContain("Total Turns:");
    expect(allText).toContain("Cache Hit Rate:");
    expect(allText).toContain("Cached Tokens:");
    expect(allText).toContain("Auto-Compaction:");
  });

  it("handles /tui command with arguments", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    await handleSlash("/tui fullscreen");
    await handleSlash("/tui regular");
    await handleSlash("/tui invalid");

    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");

    expect(allText).toContain('TUI mode set to "fullscreen"');
    expect(allText).toContain('TUI mode already "regular"');
    expect(allText).toContain("usage: /tui regular|fullscreen");
  });

  it("supports /sessions with interactive SearchableSessionPicker", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const session1 = await agent.createSession({ title: "session-alpha" });
    await agent.createSession({ title: "session-beta" });

    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: session1.thebeSessionId,
    });

    const sessionsPromise = handleSlash("/sessions");
    await new Promise((r) => setTimeout(r, 20));

    const picker = tui.children.find(
      (c) => c.constructor.name === "SearchableSessionPicker"
    ) as { handleInput: (data: string) => void } | undefined;
    expect(picker).toBeDefined();

    picker?.handleInput("\r");
    await sessionsPromise;

    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("resumed session");
  });

  it("handles /history, /export, /compact, /revert, and /unrevert", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession({ title: "robust-session" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    const visible = () =>
      tui.children
        .filter(
          (child) =>
            typeof (child as { render?: unknown }).render === "function"
        )
        .map((child) =>
          (child as { render: (w: number) => string[] }).render(80).join("\n")
        )
        .join("\n");

    await handleSlash("/history");
    expect(visible()).toContain("no messages in session");
    const tmpExportPath = `/tmp/thebe-test-export-${Date.now()}`;
    await handleSlash(`/export ${tmpExportPath}`);
    expect(visible()).toContain("exported session to");
    await handleSlash("/compact keep API decisions");
    expect(visible()).toContain("context compacted successfully");
    expect(fake.compactInstructions()).toEqual(["keep API decisions"]);
    await handleSlash("/revert");
    expect(visible()).toMatch(/reverted last turn|revert failed/);
    await handleSlash("/unrevert");
    expect(visible()).toMatch(/unreverted|unrevert failed/);
    await handleSlash("/messages 5");
    expect(visible()).toMatch(/Showing all|Showing last|no messages/);
  });

  it("supports /provider and opens searchable picker", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    // Start /provider in background
    const providerSlashPromise = handleSlash("/provider");
    await new Promise((r) => setTimeout(r, 20));

    // A provider picker component is attached
    const providerPicker = tui.children.find(
      (c) => c.constructor.name === "SearchableProviderPicker"
    ) as { handleInput: (data: string) => void } | undefined;
    expect(providerPicker).toBeDefined();

    // Confirm selection
    providerPicker?.handleInput("\r");
    await new Promise((r) => setTimeout(r, 20));

    // Next, the model picker scoped to that provider is attached
    const modelPicker = tui.children.find(
      (c) => c.constructor.name === "SearchableModelPicker"
    ) as { handleInput: (data: string) => void } | undefined;
    expect(modelPicker).toBeDefined();

    // Confirm model selection
    modelPicker?.handleInput("\r");
    await providerSlashPromise;

    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("switched model to");
  });

  it("handles /hotkeys with structured keybinding cheat sheet", async () => {
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {});

    await handleSlash("/hotkeys");

    const allText = tui.children
      .filter((child) => child instanceof Text || child instanceof Markdown)
      .map((child) => child.render(80).join("\n"))
      .join("\n");

    expect(allText).toContain("Keyboard Shortcuts");
    expect(allText).toContain("Alt+Enter");
    expect(allText).toContain("Ctrl+P");
    expect(allText).toContain("Shift+Tab");
    expect(allText).toContain("Ctrl+G");
    expect(allText).toContain("Ctrl+Shift+G");
    expect(allText).toContain("/help");
    expect(allText).not.toContain("!<command>");
  });

  it("applies /theme to existing markdown and persists the name", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "# Hello" }]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    editor.onSubmit?.("hi");
    await new Promise((r) => setTimeout(r, 60));
    await handleSlash("/theme light");
    const reply = tui.children
      .filter((child) => child instanceof Markdown)
      .at(-1)!;
    const expected = new Markdown("# Hello", 1, 1, lightMarkdownTheme)
      .render(40)
      .join("\n");
    expect(reply.render(40).join("\n")).toBe(expected);
    expect(reply.render(40).join("\n")).not.toBe(
      new Markdown("# Hello", 1, 1, defaultMarkdownTheme).render(40).join("\n")
    );
  });

  it("/tui invokes a live mode change for the chosen value", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const seen: string[] = [];
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
      onTuiModeChange: (mode) => {
        seen.push(mode);
      },
    });
    await handleSlash("/tui fullscreen");
    expect(seen).toEqual(["fullscreen"]);
    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain('switching TUI mode to "fullscreen"');
  });

  it("/settings Enter applies the highlighted setting immediately", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    const settingsPromise = handleSlash("/settings");
    await new Promise((r) => setTimeout(r, 20));
    const list = tui.children.find(
      (c) => c.constructor.name === "SettingsList"
    ) as { handleInput: (data: string) => void };
    expect(list).toBeDefined();
    list.handleInput("\r");
    await new Promise((r) => setTimeout(r, 20));
    expect(editor.borderColor).toBe(getTuiTheme("light").editor.borderColor);
    list.handleInput("\x1b");
    await settingsPromise;
  });

  it("Shift+Tab cycles thinking on the session", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    const notices = () =>
      tui.children
        .filter((child) => child instanceof Text)
        .map((child) => child.render(80).join("\n"))
        .join("\n");
    const footer = () =>
      (tui.children.at(-1) as { render: (w: number) => string[] })
        .render(80)
        .join("\n");

    editor.handleInput("\x1b[Z");
    await new Promise((r) => setTimeout(r, 30));
    expect(notices()).not.toContain("thinking level set to minimal");
    expect(tui.children.at(-1)?.constructor.name).toBe("FooterDock");
    expect(tui.children.at(-2)?.constructor.name).toBe("Editor");
    expect(footer()).toMatch(/• minimal/);
    expect(footer().trim().split("\n")[1]).toMatch(/• minimal/);

    editor.handleInput("\x1b[Z");
    await new Promise((r) => setTimeout(r, 30));
    expect(notices()).not.toContain("thinking level set to low");
    expect(footer().trim().split("\n")[1]).toMatch(/• low/);
  });

  it("permission prompt defaults to deny and offers exact-request memory", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    editor.onSubmit?.("run bash");
    await new Promise((r) => setTimeout(r, 40));
    const list = tui.children.find(
      (c) => c.constructor.name === "SelectList"
    ) as
      | {
          handleInput: (data: string) => void;
          render: (width: number) => string[];
        }
      | undefined;
    expect(list).toBeDefined();
    const choices = list!
      .render(80)
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(choices).toContain("Deny bash (high risk)");
    expect(choices).toContain("Allow bash once");
    expect(choices).toContain("Always allow bash for this session (high risk)");
    expect(choices).toContain("Allow this exact bash request only");
    expect(choices).toContain("Allow this conversation");
    list!.handleInput("\r");
    await new Promise((r) => setTimeout(r, 60));
    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toMatch(/permission .+ denied/);
  });

  it("permission prompt can remember all commands for a high-risk tool", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "first command done" },
      { kind: "tools", calls: [{ name: "bash", args: { command: "pwd" } }] },
      { kind: "text", text: "second command done" },
    ]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, isResponding } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    editor.onSubmit?.("run the first command");
    await new Promise((r) => setTimeout(r, 40));
    const list = tui.children.find(
      (c) => c.constructor.name === "SelectList"
    ) as { handleInput: (data: string) => void } | undefined;
    expect(list).toBeDefined();
    // The tool-wide choice is the third item; the first item is selected by default.
    list!.handleInput("\x1b[B");
    list!.handleInput("\x1b[B");
    list!.handleInput("\r");
    await new Promise((r) => setTimeout(r, 80));
    expect(
      (await agent.getSession(meta.thebeSessionId)).rememberedPermissions
    ).toEqual({
      bash: "allow",
    });
    expect(
      tui.children.filter((c) => c.constructor.name === "SelectList")
    ).toEqual([]);
    await vi.waitFor(() => expect(isResponding()).toBe(false));

    editor.onSubmit?.("run the second command");
    await new Promise((r) => setTimeout(r, 80));
    expect(agent.pendingPermissionIds()).toHaveLength(0);
    expect(
      tui.children.filter((c) => c.constructor.name === "SelectList")
    ).toEqual([]);
  });

  it("copyToClipboard succeeds via native clipboard or OSC 52", async () => {
    const writes: string[] = [];
    const ok = await copyToClipboard("secret-reply", (data) => {
      writes.push(data);
    });
    expect(ok).toBe(true);
    if (writes.length > 0) {
      expect(writes.join("")).toContain(
        Buffer.from("secret-reply", "utf8").toString("base64")
      );
    }
  });

  it("handles /login and /logout commands", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    const loginPromise = handleSlash("/login opencode");
    await new Promise((r) => setTimeout(r, 20));
    const keyInput = tui.children.find(
      (c) => c.constructor.name === "Input"
    ) as { handleInput: (data: string) => void } | undefined;
    expect(keyInput).toBeDefined();
    for (const char of "sk-opencode-test") {
      keyInput!.handleInput(char);
    }
    keyInput!.handleInput("\r");
    await loginPromise;

    expect(fake.apiKeys.get("opencode")).toBe("sk-opencode-test");
    await handleSlash("/logout opencode");
    expect(fake.apiKeys.has("opencode")).toBe(false);

    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("saved API key for opencode");
    expect(allText).toContain("logged out provider opencode");
  });
});

describe("Thebe TUI provider, model, and login apply the chosen item", () => {
  async function flush(ms = 20): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  function notices(tui: TUI): string {
    return tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(120).join("\n"))
      .join("\n");
  }

  function findNamed(
    tui: TUI,
    name: string
  ): {
    handleInput: (data: string) => void;
    render: (width: number) => string[];
  } {
    const child = tui.children.find((c) => c.constructor.name === name) as
      | {
          handleInput: (data: string) => void;
          render: (width: number) => string[];
        }
      | undefined;
    expect(child).toBeDefined();
    return child!;
  }

  function findNamedOrNull(
    tui: TUI,
    name: string
  ): {
    handleInput: (data: string) => void;
    render: (width: number) => string[];
  } | null {
    const child = tui.children.find((c) => c.constructor.name === name) as
      | {
          handleInput: (data: string) => void;
          render: (width: number) => string[];
        }
      | undefined;
    return child ?? null;
  }

  function typeAndConfirm(
    component: { handleInput: (data: string) => void },
    text: string
  ): void {
    for (const char of text) {
      component.handleInput(char);
    }
    component.handleInput("\r");
  }

  async function sessionModel(
    fake: ReturnType<typeof createFakeRuntime>,
    agent: ReturnType<typeof createThebeAgent>,
    thebeSessionId: string
  ) {
    const meta = await agent.getSession(thebeSessionId);
    return fake.snapshot(meta.runtimeSessionId).model;
  }

  it("/provider <id> scopes models and session to that provider for every listed provider", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const providers = await agent.listProviders();
    const allModels = await agent.listAvailableModels();
    expect(providers.length).toBeGreaterThan(2);

    for (const listed of providers) {
      const meta = await agent.createSession();
      const before = await sessionModel(fake, agent, meta.thebeSessionId);
      const tui: TUI = new TuiMainScreen(new MemoryTerminal());
      const { handleSlash } = attachThebeChat(tui, {
        agent,
        sessionId: meta.thebeSessionId,
      });

      const slashPromise = handleSlash(`/provider ${listed.id}`);
      const modelsForProvider = allModels.filter(
        (m) => m.providerId === listed.id
      );
      if (modelsForProvider.length === 0) {
        await slashPromise;
        expect(notices(tui).toLowerCase()).toContain(listed.id);
        expect(notices(tui)).toMatch(/no models available for provider/i);
        expect(
          tui.children.some((c) => c instanceof SearchableModelPicker)
        ).toBe(false);
        expect(await sessionModel(fake, agent, meta.thebeSessionId)).toEqual(
          before
        );
        continue;
      }

      await flush();
      const modelPicker = tui.children.find(
        (c) => c instanceof SearchableModelPicker
      ) as SearchableModelPicker;
      expect(modelPicker).toBeDefined();
      const rendered = modelPicker.render(80).join("\n");
      expect(rendered).toContain(`[${listed.id}]`);
      for (const other of providers) {
        if (other.id === listed.id) continue;
        expect(rendered).not.toContain(`[${other.id}]`);
      }
      modelPicker.handleInput("\r");
      await slashPromise;

      const model = await sessionModel(fake, agent, meta.thebeSessionId);
      expect(model.providerId).toBe(listed.id);
      expect(notices(tui)).toContain(`switched model to ${listed.id}/`);
    }
  });

  it("/provider picker Enter applies the highlighted provider, including case-insensitive ids", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const providers = (await agent.listProviders()).filter((p) =>
      FAKE_RUNTIME_MODELS.some((m) => m.providerId === p.id)
    );
    expect(providers.length).toBeGreaterThan(1);

    for (const listed of providers) {
      const meta = await agent.createSession();
      const tui: TUI = new TuiMainScreen(new MemoryTerminal());
      const { handleSlash } = attachThebeChat(tui, {
        agent,
        sessionId: meta.thebeSessionId,
      });
      const slashPromise = handleSlash("/provider");
      await flush();
      typeAndConfirm(findNamed(tui, "SearchableProviderPicker"), listed.id);
      await flush();
      const modelPicker = tui.children.find(
        (c) => c instanceof SearchableModelPicker
      ) as SearchableModelPicker;
      expect(modelPicker.render(80).join("\n")).toContain(`[${listed.id}]`);
      for (const other of providers) {
        if (other.id === listed.id) continue;
        expect(modelPicker.render(80).join("\n")).not.toContain(
          `[${other.id}]`
        );
      }
      modelPicker.handleInput("\r");
      await slashPromise;
      expect(
        (await sessionModel(fake, agent, meta.thebeSessionId)).providerId
      ).toBe(listed.id);
    }

    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    const mixed = providers[0]!;
    const slashPromise = handleSlash(`/provider ${mixed.id.toUpperCase()}`);
    await flush();
    const modelPicker = tui.children.find(
      (c) => c instanceof SearchableModelPicker
    ) as SearchableModelPicker;
    modelPicker.handleInput("\r");
    await slashPromise;
    expect(
      (await sessionModel(fake, agent, meta.thebeSessionId)).providerId
    ).toBe(mixed.id);
  });

  it("empty model list for a provider names that provider and does not switch models", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const providers = await agent.listProviders();
    const allModels = await agent.listAvailableModels();
    const empty = providers.find(
      (p) => !allModels.some((m) => m.providerId === p.id)
    );
    expect(empty).toBeDefined();

    const meta = await agent.createSession();
    const before = await sessionModel(fake, agent, meta.thebeSessionId);
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    await handleSlash(`/provider ${empty!.id}`);
    expect(notices(tui)).toMatch(
      new RegExp(`no models available for provider ${empty!.id}`, "i")
    );
    expect(await sessionModel(fake, agent, meta.thebeSessionId)).toEqual(
      before
    );
  });

  it("/login API key persists for every apiKey provider; /logout clears that same id", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    const providers = await agent.listProviders();
    const apiKeyProviders = providers.filter((p) =>
      p.authMethods?.includes("apiKey")
    );
    expect(apiKeyProviders.length).toBeGreaterThan(1);

    for (const listed of apiKeyProviders) {
      const loginPromise = handleSlash(`/login ${listed.id}`);
      await flush();
      if (listed.authMethods?.includes("oauth")) {
        findNamed(tui, "SelectList").handleInput("\x1b[B");
        findNamed(tui, "SelectList").handleInput("\r");
        await flush();
      }
      const key = `sk-${listed.id}-live`;
      typeAndConfirm(findNamed(tui, "Input"), key);
      await loginPromise;
      expect(fake.apiKeys.get(listed.id)).toBe(key);
      if (FAKE_RUNTIME_MODELS.some((m) => m.providerId === listed.id)) {
        expect(
          (await sessionModel(fake, agent, meta.thebeSessionId)).providerId
        ).toBe(listed.id);
      }
      await handleSlash(`/logout ${listed.id}`);
      expect(fake.apiKeys.has(listed.id)).toBe(false);
    }
  });

  it("/login OAuth authorize+callback connects every oauth provider, not a hardcoded id", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    const oauthProviders = (await agent.listProviders()).filter((p) =>
      p.authMethods?.includes("oauth")
    );
    expect(oauthProviders.length).toBeGreaterThan(1);

    for (const listed of oauthProviders) {
      const loginPromise = handleSlash(`/login ${listed.id}`);
      await flush();
      if (listed.authMethods?.includes("apiKey")) {
        findNamed(tui, "SelectList").handleInput("\r");
        await flush();
      }
      const shown = notices(tui);
      expect(shown.toLowerCase()).toContain(listed.id);
      expect(shown).toMatch(/oauth\.example|device login|authorize/i);
      typeAndConfirm(findNamed(tui, "Input"), `oauth-code-${listed.id}`);
      await loginPromise;
      expect(fake.oauthLogins).toContain(listed.id);
      const row = (await agent.listProviders()).find((p) => p.id === listed.id);
      expect(row?.authStatus).toBe("connected");
      if (FAKE_RUNTIME_MODELS.some((m) => m.providerId === listed.id)) {
        expect(
          (await sessionModel(fake, agent, meta.thebeSessionId)).providerId
        ).toBe(listed.id);
      }
      await handleSlash(`/logout ${listed.id}`);
      expect(fake.oauthLogins).not.toContain(listed.id);
    }
  });

  it("/login with no arg authenticates the highlighted provider id", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });
    const providers = await agent.listProviders();
    const chosen = providers.find(
      (p) =>
        p.authMethods?.includes("apiKey") && !p.authMethods?.includes("oauth")
    );
    expect(chosen).toBeDefined();

    const loginPromise = handleSlash("/login");
    await flush();
    const list = findNamed(tui, "SearchableProviderPicker") as unknown as {
      filteredProviders: Array<{ id: string }>;
      handleInput: (data: string) => void;
    };
    const index = list.filteredProviders.findIndex((p) => p.id === chosen!.id);
    for (let i = 0; i < index; i++) {
      list.handleInput("\x1b[B");
    }
    list.handleInput("\r");
    await flush();
    typeAndConfirm(findNamed(tui, "Input"), "sk-from-list");
    await loginPromise;

    expect(fake.apiKeys.get(chosen!.id)).toBe("sk-from-list");
    for (const other of providers) {
      if (other.id === chosen!.id) continue;
      expect(fake.apiKeys.has(other.id)).toBe(false);
    }
  });

  it("/model some-unprefixed-id does not invent provider opencode", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession();
    const before = await sessionModel(fake, agent, meta.thebeSessionId);
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    const slashPromise = handleSlash("/model some-unprefixed-id");
    await flush();
    const picker = tui.children.find(
      (c) => c instanceof SearchableModelPicker
    ) as SearchableModelPicker | undefined;
    expect(picker).toBeDefined();
    const listed = picker!.render(80).join("\n");
    expect(listed).not.toContain("opencode/some-unprefixed-id");
    picker!.handleInput("\x1b");
    await slashPromise;

    const after = await sessionModel(fake, agent, meta.thebeSessionId);
    expect(after).toEqual(before);
    expect(notices(tui)).not.toContain("switched model to opencode/");
  });

  it("/custom wizard runs API, Base URL, ID, Key, auto-fetches models and selects", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "auto-model-1", name: "Auto Model One" },
              { id: "auto-model-2", name: "Auto Model Two" },
            ],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    try {
      const fake = createFakeRuntime();
      const agent = createThebeAgent({ runtime: fake.runtime, provider });
      const meta = await agent.createSession();
      const tui: TUI = new TuiMainScreen(new MemoryTerminal());
      const { handleSlash } = attachThebeChat(tui, {
        agent,
        sessionId: meta.thebeSessionId,
      });

      const customPromise = handleSlash("/custom");
      await flush();

      // Step 1: Select API (SelectList) - Press Enter on first option (openai-completions)
      const apiSelect = findNamed(tui, "SelectList");
      apiSelect.handleInput("\r");
      await flush();

      // Step 2: Base URL endpoint (Input)
      const urlInput = findNamed(tui, "Input");
      typeAndConfirm(urlInput, `http://127.0.0.1:${port}/v1`);
      await flush();

      // Step 3: Provider ID (Input)
      const idInput = findNamed(tui, "Input");
      typeAndConfirm(idInput, "test-custom-provider");
      await flush();

      // Step 4: API Key (Input). Confirming it triggers the model fetch, so the
      // next step waits for the SelectList instead of a fixed delay.
      const keyInput = findNamed(tui, "Input");
      typeAndConfirm(keyInput, "sk-custom-secret");

      // Step 5: Auto-fetched Model selection (SelectList)
      await vi.waitFor(
        () => expect(findNamedOrNull(tui, "SelectList")).not.toBeNull(),
        { timeout: 10_000 }
      );
      const modelSelect = findNamed(tui, "SelectList");
      // Select first auto-fetched model (auto-model-1)
      modelSelect.handleInput("\r");
      await flush();

      // Step 6: Reasoning / thinking prompt (Input)
      const reasoningInput = findNamed(tui, "Input");
      expect(reasoningInput).toBeDefined();
      typeAndConfirm(reasoningInput, "y");
      await customPromise;

      expect(notices(tui)).toContain(
        "configured custom provider test-custom-provider (auto-model-1)"
      );
      expect(fake.apiKeys.get("test-custom-provider")).toBe("sk-custom-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("dynamically updates editor border color when typing ! for bash mode", () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, { agent });

    const initialBorder = editor.borderColor;
    // Enter bash mode
    editor.onChange?.("!echo hello");
    expect(editor.borderColor).not.toBe(initialBorder);
    expect(editor.borderColor).toBe(getBashModeBorderColor("dark"));

    // Exit bash mode
    editor.onChange?.("echo hello");
    expect(editor.borderColor).toBe(initialBorder);
  });

  it("handles /settings opening the standard settings items", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, { agent });

    const settingsPromise = handleSlash("/settings");
    await flush();

    const settingsList = findNamed(tui, "SettingsList") as any;
    expect(settingsList).toBeDefined();
    const itemIds = settingsList.items.map((i: any) => i.id);
    expect(itemIds).toEqual([
      "theme",
      "thinking",
      "tui",
      "permissionMode",
      "sandboxEnabled",
      "autoCompact",
      "autoSummary",
      "autoSummaryDelay",
      "steeringMode",
      "followUpMode",
      "hideThinking",
      "quietStartup",
      "fullscreenExitOutput",
      "fullscreenScrollbar",
    ]);

    // Close settings list
    settingsList.handleInput("\x1b"); // Escape
    await settingsPromise;
    expect(findNamedOrNull(tui, "SettingsList")).toBeNull();
  });

  it("handles /agents listing active agents and sessions", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession({ title: "agent-session-1" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    await handleSlash("/agents");
    const allText = tui.children
      .filter((child) => child instanceof Text || child instanceof Markdown)
      .map((child) => child.render(80).join("\n"))
      .join("\n");

    expect(allText).toContain("Active Agents");
    expect(allText).toContain(meta.thebeSessionId.slice(0, 8));
  });

  it("does not show every saved conversation in /agents", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const current = await agent.createSession({ title: "current" });
    const oldOne = await agent.createSession({ title: "old one" });
    const oldTwo = await agent.createSession({ title: "old two" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: current.thebeSessionId,
    });

    await handleSlash("/agents");
    const allText = tui.children
      .filter((child) => child instanceof Text || child instanceof Markdown)
      .map((child) => child.render(120).join("\n"))
      .join("\n");

    expect(allText).toContain(current.thebeSessionId.slice(0, 8));
    expect(allText).not.toContain(oldOne.thebeSessionId.slice(0, 8));
    expect(allText).not.toContain(oldTwo.thebeSessionId.slice(0, 8));
  });

  it("handles /new, /export, /fork, /revert, /skills, /mcp, and /subagent", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "first-reply" }]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession({ title: "orig" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    editor.onSubmit?.("hello-turn");
    await new Promise((r) => setTimeout(r, 40));

    const turns = await agent.getForkMessages(meta.thebeSessionId);
    expect(turns.length).toBeGreaterThan(0);
    await handleSlash(`/fork ${turns[0]!.entryId}`);
    let allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("forked session");

    await handleSlash(
      `/export ${join(tmpdir(), `thebe-export-${meta.thebeSessionId.slice(0, 8)}`)}`
    );
    allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("exported session to");
    expect(allText).toMatch(/jsonl|html/);

    await handleSlash("/revert");
    allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("reverted last turn");

    await handleSlash("/skills list");
    allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("no skills found");
    await handleSlash("/mcp list");
    allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toMatch(/container\.list|list_core_events/);
    await handleSlash("/subagent list");
    allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("no subagent runs");
    await handleSlash("/new");
    allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("new session created");
    expect(
      tui.children.filter((child) => child instanceof Markdown)
    ).toHaveLength(0);
  });

  it("/fork without an argument opens a picker and switches to the selected branch", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "forkable reply" }]);
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const parent = await agent.createSession({ title: "parent" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: parent.thebeSessionId,
    });

    editor.onSubmit?.("fork this turn");
    await new Promise((r) => setTimeout(r, 40));
    const before = tui.children
      .filter((child) => child instanceof Markdown)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(before).toContain("forkable reply");

    const forkPromise = handleSlash("/fork");
    await new Promise((r) => setTimeout(r, 20));
    const picker = tui.children.find(
      (c) => c.constructor.name === "SelectList"
    ) as { handleInput: (data: string) => void } | undefined;
    expect(picker).toBeDefined();
    picker!.handleInput("\r");
    await forkPromise;

    expect(tui.children.some((c) => c.constructor.name === "SelectList")).toBe(
      false
    );
    const current = agent.lastThebeSessionId();
    expect(current).toBeDefined();
    expect(current).not.toBe(parent.thebeSessionId);
    expect((await agent.getSession(current!)).parentThebeSessionId).toBe(
      parent.thebeSessionId
    );
    expect(
      (await agent.loadMessages(current!)).map((message) => message.text)
    ).toEqual(["fork this turn"]);
    expect(editor.getText()).toBe("fork this turn");
  });

  it("keeps MCP test actions out of the menu and confirms session deletion", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({ runtime: fake.runtime, provider });
    const meta = await agent.createSession({ title: "remove me" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      agent,
      sessionId: meta.thebeSessionId,
    });

    const mcpPromise = handleSlash("/mcp");
    await vi.waitFor(() => {
      expect(
        tui.children.some((child) => child.constructor.name === "SelectList")
      ).toBe(true);
    });
    let list = tui.children.find(
      (child) => child.constructor.name === "SelectList"
    ) as {
      handleInput: (data: string) => void;
      render: (width: number) => string[];
    };
    expect(list.render(80).join("\n")).not.toContain("Test MCP tool");
    list.handleInput("\x1b");
    await mcpPromise;

    const deletePromise = handleSlash("/delete");
    await vi.waitFor(() => {
      expect(
        tui.children.some((child) => child.constructor.name === "SelectList")
      ).toBe(true);
    });
    list = tui.children.find(
      (child) => child.constructor.name === "SelectList"
    ) as typeof list;
    expect(list.render(80).join("\n")).toContain(
      "Delete remove me and transcript"
    );
    list.handleInput("\x1b[B");
    list.handleInput("\r");
    await deletePromise;
    expect(await agent.listSessions()).toHaveLength(0);
    expect(await fake.runtime.listSessions()).toHaveLength(0);
  });
});
