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
import { attachThebeChat } from "./app.ts";
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
});
