import { describe, expect, it } from "vitest";
import {
  Markdown,
  Text,
  TuiMainScreen,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import { createThebeProduct } from "../product/service.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import {
  createFakeRuntime,
  FAKE_RUNTIME_MODELS,
} from "../runtime/fake-runtime.ts";
import {
  attachThebeChat,
  copyToClipboard,
  formatCwd,
  formatTokens,
  resolveSlashName,
  SLASH_COMMANDS,
} from "./app.ts";
import { SearchableModelPicker } from "./model-picker.ts";
import {
  defaultMarkdownTheme,
  getTuiTheme,
  lightMarkdownTheme,
} from "./theme.ts";

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
  it("renders markdown with pi-tui's default theme", () => {
    const md = new Markdown(
      "# Status\n\n**25 running** and `nginx`\n\n- one\n- two",
      1,
      1,
      defaultMarkdownTheme,
    );
    const joined = md.render(40).join("\n");
    expect(joined).toContain("Status");
    expect(joined).toContain("25 running");
    expect(joined).not.toContain("**25 running**");
    expect(joined).not.toContain("# Status");
    expect(joined).toContain("\x1b[");
  });

  it("splices the reply before the Editor, like chat-simple", async () => {
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      send: async () => "**25 running**",
    });
    editor.onSubmit?.("hello");
    await new Promise((r) => setTimeout(r, 40));
    const markdown = tui.children.filter(
      (child) => child instanceof Markdown,
    );
    expect(markdown).toHaveLength(2);
    expect(markdown[0]!.render(40).join("\n")).toContain("hello");
    const reply = markdown[1]!.render(40).join("\n");
    expect(reply).toContain("25 running");
    expect(reply).not.toContain("**25 running**");
    expect(tui.children.at(-1)?.constructor.name).toBe("Editor");
    expect(
      tui.children.some((child) => child.constructor.name === "Loader"),
    ).toBe(false);
  });

  it("clears messages with /clear and keeps the editor", () => {
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      send: async () => "unused",
    });
    tui.children.splice(
      tui.children.length - 1,
      0,
      new Markdown("keep-me-not", 1, 1, defaultMarkdownTheme),
    );
    editor.onSubmit?.("/clear");
    expect(tui.children.some((child) => child instanceof Markdown)).toBe(
      false,
    );
    expect(tui.children.at(-1)?.constructor.name).toBe("Editor");
  });
});

describe("Thebe TUI product slash commands", () => {
  it("handles /session and /help via product", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession({ title: "tui-demo" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });
    editor.onSubmit?.("/help");
    await new Promise((r) => setTimeout(r, 20));
    const helpText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(helpText).toContain("/compact");
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

  it("prompts through product and shows reply", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "**ok**" }]);
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });
    editor.onSubmit?.("hello");
    await new Promise((r) => setTimeout(r, 60));
    const markdown = tui.children.filter((child) => child instanceof Markdown);
    expect(markdown.length).toBeGreaterThanOrEqual(2);
    const reply = markdown.at(-1)!.render(40).join("\n");
    expect(reply).toContain("ok");
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
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, handleSlash } = attachThebeChat(tui, {
      product,
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
    // /tree
    await handleSlash("/tree");

    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");

    expect(allText).toContain("switched model to fake/fake-2");
    expect(allText).toContain("thinking level set to high");
    expect(allText).toContain("theme set to light");
    expect(allText).toContain("theme set to dark");
    expect(allText).toContain("Ctrl+P");
    expect(allText).toContain("Alt+Enter");
    expect(allText).toContain(meta.thebeSessionId.slice(0, 8));
  });

  it("handles /copy when no assistant response vs with assistant response", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });

    await handleSlash("/copy");
    let allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("no assistant response found to copy");

    fake.queueTurns([{ kind: "text", text: "Generated assistant response for copy" }]);
    await product.prompt("hello", { thebeSessionId: meta.thebeSessionId });
    await handleSlash("/copy");

    allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toMatch(/copied last response|clipboard command unavailable/);
  });

  it("registers slash commands in OpenCode Session/Agent/Provider/System groups", () => {
    const byCategory = (category: string) =>
      SLASH_COMMANDS.filter((c) => c.category === category).map((c) => c.name);
    expect(byCategory("Session")).toEqual(
      expect.arrayContaining([
        "sessions",
        "new",
        "compact",
        "copy",
        "fork",
        "revert",
      ]),
    );
    expect(byCategory("Agent")).toEqual(
      expect.arrayContaining(["model", "thinking"]),
    );
    expect(byCategory("Provider")).toEqual(
      expect.arrayContaining(["login", "logout", "provider"]),
    );
    expect(byCategory("System")).toEqual(
      expect.arrayContaining(["theme", "help", "quit", "settings"]),
    );
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain("messages");
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain("delete");
    expect(resolveSlashName("models")).toBe("model");
    expect(resolveSlashName("connect")).toBe("login");
    expect(resolveSlashName("themes")).toBe("theme");
    expect(resolveSlashName("undo")).toBe("revert");
    expect(resolveSlashName("exit")).toBe("quit");
    expect(resolveSlashName("resume")).toBe("sessions");
  });

  it("handles /usage displaying context, token stats, turns, and cache hit rate", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession({ title: "usage-session" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
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
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
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
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const session1 = await product.createSession({ title: "session-alpha" });
    const session2 = await product.createSession({ title: "session-beta" });

    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: session1.thebeSessionId,
    });

    const sessionsPromise = handleSlash("/sessions");
    await new Promise((r) => setTimeout(r, 20));

    const picker = tui.children.find(
      (c) => c.constructor.name === "SearchableSessionPicker",
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

  it("handles /export, /compact, /revert, /unrevert, and /messages limit", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession({ title: "robust-session" });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });

    // /messages on empty session
    await handleSlash("/messages");
    // /export to custom path in temp
    const tmpExportPath = `/tmp/thebe-test-export-${Date.now()}`;
    await handleSlash(`/export ${tmpExportPath}`);
    // /compact
    await handleSlash("/compact");
    // /revert on empty session (should not crash)
    await handleSlash("/revert");
    // /unrevert on empty session (should not crash)
    await handleSlash("/unrevert");
    // /messages after compact (shows compacted turn)
    await handleSlash("/messages 5");

    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");

    expect(allText).toContain("no messages in session");
    expect(allText).toContain("exported session to");
    expect(allText).toContain("context compacted successfully");
    expect(allText).toContain("revert failed: nothing to revert");
    expect(allText).toContain("unrevert failed: nothing to unrevert");
    expect(allText).toContain("[Showing all 1 messages]");
    expect(allText).toContain("[assistant] [compacted]");
  });

  it("supports /provider and opens searchable picker", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });

    // Start /provider in background
    const providerSlashPromise = handleSlash("/provider");
    await new Promise((r) => setTimeout(r, 20));

    // A provider picker component is attached
    const providerPicker = tui.children.find(
      (c) => c.constructor.name === "SearchableProviderPicker",
    ) as { handleInput: (data: string) => void } | undefined;
    expect(providerPicker).toBeDefined();

    // Confirm selection
    providerPicker?.handleInput("\r");
    await new Promise((r) => setTimeout(r, 20));

    // Next, the model picker scoped to that provider is attached
    const modelPicker = tui.children.find(
      (c) => c.constructor.name === "SearchableModelPicker",
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
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");

    expect(allText).toContain("Keyboard shortcuts");
    expect(allText).toContain("Alt+Enter");
    expect(allText).toContain("Ctrl+P");
    expect(allText).toContain("Shift+Tab");
    expect(allText).toContain("/help");
    expect(allText).not.toContain("!<command>");
  });

  it("applies /theme to existing markdown and persists the name", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "# Hello" }]);
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, handleSlash } = attachThebeChat(tui, {
      product,
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
      new Markdown("# Hello", 1, 1, defaultMarkdownTheme).render(40).join("\n"),
    );
  });

  it("/tui invokes a live mode change for the chosen value", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const seen: string[] = [];
    const { handleSlash } = attachThebeChat(tui, {
      product,
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
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor, handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });
    const settingsPromise = handleSlash("/settings");
    await new Promise((r) => setTimeout(r, 20));
    const list = tui.children.find(
      (c) => c.constructor.name === "SettingsList",
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
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });
    editor.handleInput("\x1b[Z");
    await new Promise((r) => setTimeout(r, 30));
    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toContain("thinking level set to low");
  });

  it("permission prompt Enter allow/deny resolves that permission", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "after" },
    ]);
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });
    editor.onSubmit?.("run bash");
    await new Promise((r) => setTimeout(r, 40));
    const list = tui.children.find(
      (c) => c.constructor.name === "SelectList",
    ) as { handleInput: (data: string) => void } | undefined;
    expect(list).toBeDefined();
    list!.handleInput("\x1b[B");
    list!.handleInput("\r");
    await new Promise((r) => setTimeout(r, 60));
    const allText = tui.children
      .filter((child) => child instanceof Text)
      .map((child) => child.render(80).join("\n"))
      .join("\n");
    expect(allText).toMatch(/permission .+ denied/);
  });

  it("copyToClipboard succeeds via native clipboard or OSC 52", async () => {
    const writes: string[] = [];
    const ok = await copyToClipboard("secret-reply", (data) => {
      writes.push(data);
    });
    expect(ok).toBe(true);
    if (writes.length > 0) {
      expect(writes.join("")).toContain(
        Buffer.from("secret-reply", "utf8").toString("base64"),
      );
    }
  });

  it("handles /login and /logout commands", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });

    const loginPromise = handleSlash("/login opencode");
    await new Promise((r) => setTimeout(r, 20));
    const keyInput = tui.children.find(
      (c) => c.constructor.name === "Input",
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
    name: string,
  ): { handleInput: (data: string) => void; render: (width: number) => string[] } {
    const child = tui.children.find((c) => c.constructor.name === name) as
      | { handleInput: (data: string) => void; render: (width: number) => string[] }
      | undefined;
    expect(child).toBeDefined();
    return child!;
  }

  function typeAndConfirm(
    component: { handleInput: (data: string) => void },
    text: string,
  ): void {
    for (const char of text) {
      component.handleInput(char);
    }
    component.handleInput("\r");
  }

  async function sessionModel(
    fake: ReturnType<typeof createFakeRuntime>,
    product: ReturnType<typeof createThebeProduct>,
    thebeSessionId: string,
  ) {
    const meta = await product.getSession(thebeSessionId);
    return fake.snapshot(meta.runtimeSessionId).model;
  }

  it("/provider <id> scopes models and session to that provider for every listed provider", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const providers = await product.listProviders();
    const allModels = await product.listAvailableModels();
    expect(providers.length).toBeGreaterThan(2);

    for (const listed of providers) {
      const meta = await product.createSession();
      const before = await sessionModel(fake, product, meta.thebeSessionId);
      const tui: TUI = new TuiMainScreen(new MemoryTerminal());
      const { handleSlash } = attachThebeChat(tui, {
        product,
        sessionId: meta.thebeSessionId,
      });

      const slashPromise = handleSlash(`/provider ${listed.id}`);
      const modelsForProvider = allModels.filter(
        (m) => m.providerId === listed.id,
      );
      if (modelsForProvider.length === 0) {
        await slashPromise;
        expect(notices(tui).toLowerCase()).toContain(listed.id);
        expect(notices(tui)).toMatch(/no models available for provider/i);
        expect(
          tui.children.some((c) => c instanceof SearchableModelPicker),
        ).toBe(false);
        expect(await sessionModel(fake, product, meta.thebeSessionId)).toEqual(
          before,
        );
        continue;
      }

      await flush();
      const modelPicker = tui.children.find(
        (c) => c instanceof SearchableModelPicker,
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

      const model = await sessionModel(fake, product, meta.thebeSessionId);
      expect(model.providerId).toBe(listed.id);
      expect(notices(tui)).toContain(`switched model to ${listed.id}/`);
    }
  });

  it("/provider picker Enter applies the highlighted provider, including case-insensitive ids", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const providers = (await product.listProviders()).filter((p) =>
      FAKE_RUNTIME_MODELS.some((m) => m.providerId === p.id),
    );
    expect(providers.length).toBeGreaterThan(1);

    for (const listed of providers) {
      const meta = await product.createSession();
      const tui: TUI = new TuiMainScreen(new MemoryTerminal());
      const { handleSlash } = attachThebeChat(tui, {
        product,
        sessionId: meta.thebeSessionId,
      });
      const slashPromise = handleSlash("/provider");
      await flush();
      typeAndConfirm(findNamed(tui, "SearchableProviderPicker"), listed.id);
      await flush();
      const modelPicker = tui.children.find(
        (c) => c instanceof SearchableModelPicker,
      ) as SearchableModelPicker;
      expect(modelPicker.render(80).join("\n")).toContain(`[${listed.id}]`);
      for (const other of providers) {
        if (other.id === listed.id) continue;
        expect(modelPicker.render(80).join("\n")).not.toContain(
          `[${other.id}]`,
        );
      }
      modelPicker.handleInput("\r");
      await slashPromise;
      expect(
        (await sessionModel(fake, product, meta.thebeSessionId)).providerId,
      ).toBe(listed.id);
    }

    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });
    const mixed = providers[0]!;
    const slashPromise = handleSlash(
      `/provider ${mixed.id.toUpperCase()}`,
    );
    await flush();
    const modelPicker = tui.children.find(
      (c) => c instanceof SearchableModelPicker,
    ) as SearchableModelPicker;
    modelPicker.handleInput("\r");
    await slashPromise;
    expect(
      (await sessionModel(fake, product, meta.thebeSessionId)).providerId,
    ).toBe(mixed.id);
  });

  it("empty model list for a provider names that provider and does not switch models", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const providers = await product.listProviders();
    const allModels = await product.listAvailableModels();
    const empty = providers.find(
      (p) => !allModels.some((m) => m.providerId === p.id),
    );
    expect(empty).toBeDefined();

    const meta = await product.createSession();
    const before = await sessionModel(fake, product, meta.thebeSessionId);
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });
    await handleSlash(`/provider ${empty!.id}`);
    expect(notices(tui)).toMatch(
      new RegExp(`no models available for provider ${empty!.id}`, "i"),
    );
    expect(await sessionModel(fake, product, meta.thebeSessionId)).toEqual(
      before,
    );
  });

  it("/login API key persists for every apiKey provider; /logout clears that same id", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });
    const providers = await product.listProviders();
    const apiKeyProviders = providers.filter((p) =>
      p.authMethods?.includes("apiKey"),
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
          (await sessionModel(fake, product, meta.thebeSessionId)).providerId,
        ).toBe(listed.id);
      }
      await handleSlash(`/logout ${listed.id}`);
      expect(fake.apiKeys.has(listed.id)).toBe(false);
    }
  });

  it("/login OAuth authorize+callback connects every oauth provider, not a hardcoded id", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });
    const oauthProviders = (await product.listProviders()).filter((p) =>
      p.authMethods?.includes("oauth"),
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
      const row = (await product.listProviders()).find((p) => p.id === listed.id);
      expect(row?.authStatus).toBe("connected");
      if (FAKE_RUNTIME_MODELS.some((m) => m.providerId === listed.id)) {
        expect(
          (await sessionModel(fake, product, meta.thebeSessionId)).providerId,
        ).toBe(listed.id);
      }
      await handleSlash(`/logout ${listed.id}`);
      expect(fake.oauthLogins).not.toContain(listed.id);
    }
  });

  it("/login with no arg authenticates the highlighted provider id", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });
    const providers = await product.listProviders();
    const chosen = providers.find(
      (p) =>
        p.authMethods?.includes("apiKey") && !p.authMethods?.includes("oauth"),
    );
    expect(chosen).toBeDefined();

    const loginPromise = handleSlash("/login");
    await flush();
    const list = findNamed(tui, "SelectList");
    const index = providers.findIndex((p) => p.id === chosen!.id);
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
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const meta = await product.createSession();
    const before = await sessionModel(fake, product, meta.thebeSessionId);
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { handleSlash } = attachThebeChat(tui, {
      product,
      sessionId: meta.thebeSessionId,
    });

    const slashPromise = handleSlash("/model some-unprefixed-id");
    await flush();
    const picker = tui.children.find(
      (c) => c instanceof SearchableModelPicker,
    ) as SearchableModelPicker | undefined;
    expect(picker).toBeDefined();
    const listed = picker!.render(80).join("\n");
    expect(listed).not.toContain("opencode/some-unprefixed-id");
    picker!.handleInput("\x1b");
    await slashPromise;

    const after = await sessionModel(fake, product, meta.thebeSessionId);
    expect(after).toEqual(before);
    expect(notices(tui)).not.toContain("switched model to opencode/");
  });
});

