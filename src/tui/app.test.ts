import { describe, expect, it } from "vitest";
import {
  Markdown,
  TuiMainScreen,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
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

  it("splices the Ask reply before the Editor, like chat-simple", async () => {
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());
    const { editor } = attachThebeChat(tui, {
      ask: async () => "**25 running**",
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
      ask: async () => "unused",
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
