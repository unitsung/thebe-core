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
import { createFakeRuntime } from "../runtime/fake-runtime.ts";
import { attachThebeChat, formatCwd, formatTokens, SLASH_COMMANDS } from "./app.ts";
import { defaultMarkdownTheme } from "./theme.ts";

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

  it("registers updated SLASH_COMMANDS without useless commands", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain("model");
    expect(names).toContain("provider");
    expect(names).toContain("thinking");
    expect(names).toContain("settings");
    expect(names).toContain("usage");
    expect(names).toContain("tui");
    expect(names).toContain("session");
    expect(names).toContain("sessions");
    expect(names).toContain("fork");
    expect(names).toContain("tree");
    expect(names).toContain("theme");
    expect(names).toContain("copy");
    expect(names).toContain("hotkeys");
    // Pruned commands must NOT be present
    expect(names).not.toContain("login");
    expect(names).not.toContain("logout");
    expect(names).not.toContain("delete");
  });

  it("handles /usage displaying context and token stats", async () => {
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

    expect(allText).toContain("Token & Context Usage");
    expect(allText).toContain(meta.thebeSessionId);
    expect(allText).toContain("Context Bar:");
    expect(allText).toContain("Compaction:");
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
    expect(allText).toContain('TUI mode set to "regular"');
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
});

