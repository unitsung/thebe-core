import { describe, expect, it } from "vitest";
import { TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import {
  ThinkingBlock,
  ElapsedWorking,
  createToolRenderers,
  createToolComponent,
  toolResultPayload,
} from "./transcript.ts";
import { getPiThemeInstance } from "../../runtime/pi/official-ui.ts";

class TestTerminal implements Terminal {
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

describe("transcript components", () => {
  it("ThinkingBlock renders folded by default with elapsed seconds and Ctrl+T hint", () => {
    const tb = new ThinkingBlock(true);
    tb.append("Let me ponder the architecture of this universe...\nSecond thought.");
    tb.finish(3);

    expect(tb.isFinished()).toBe(true);
    expect(tb.getDurationSeconds()).toBe(3);

    // When hidden
    const foldedLines = tb.render(80);
    expect(foldedLines.length).toBe(1);
    expect(foldedLines[0]).toContain("thought for 3s");
    expect(foldedLines[0]).toContain("Ctrl+T");
    expect(foldedLines[0]).not.toContain("Let me ponder");

    // When unfolded
    tb.setHidden(false);
    const unfoldedLines = tb.render(80);
    expect(unfoldedLines.length).toBeGreaterThan(1);
    expect(unfoldedLines[0]).toContain("thought for 3s");
    expect(unfoldedLines[0]).toContain("Ctrl+T");
    expect(unfoldedLines.join("\n")).toContain("Let me ponder");
    expect(unfoldedLines.join("\n")).toContain("Second thought.");
  });

  it("shows an active thinking indicator when the provider redacts the body", () => {
    const tb = new ThinkingBlock(false);

    expect(tb.render(80).join("\n")).toContain("Thinking...");

    tb.finish(1);
    expect(tb.render(80)).toEqual([]);
  });

  it("ElapsedWorking counts elapsed seconds and sets labels", () => {
    const term = new TestTerminal();
    const tui = new TuiMainScreen(term);
    const working = new ElapsedWorking(tui);

    working.setLabel("Thinking");
    expect(working.getElapsedSeconds()).toBeGreaterThanOrEqual(0);

    working.setLabel("bash");
    expect(working.getElapsedSeconds()).toBeGreaterThanOrEqual(0);

    working.stop();
  });

  it("createToolRenderers formats tool calls with real arguments and renders diffs", () => {
    const term = new TestTerminal();
    const tui = new TuiMainScreen(term);
    const theme = getPiThemeInstance("dark");

    // Test bash tool call
    const bashRenderers = createToolRenderers("bash");
    const bashCallComp = bashRenderers.renderCall({ command: "npm test --run" }, theme);
    const bashRendered = bashCallComp.render(80).join("\n");
    expect(bashRendered).toContain("bash");
    expect(bashRendered).toContain("npm test --run");

    // Test edit_file tool call and diff result
    const editRenderers = createToolRenderers("edit_file");
    const editCallComp = editRenderers.renderCall({ path: "src/tui/chat.ts" }, theme);
    const editRendered = editCallComp.render(80).join("\n");
    expect(editRendered).toContain("edit_file");
    expect(editRendered).toContain("src/tui/chat.ts");

    // Test diff rendering
    const sampleDiff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "+const b = 2;",
      " const c = 3;",
    ].join("\n");

    const diffResultComp = editRenderers.renderResult(
      {
        content: [{ type: "text", text: sampleDiff }],
        details: { diff: sampleDiff },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: { path: "src/foo.ts" } },
    );
    const diffRendered = diffResultComp.render(80).join("\n");
    expect(diffRendered).not.toContain("+const b = 2;");
    expect(diffRendered).toContain("Ctrl+O");

    const expandedDiffRendered = editRenderers.renderResult(
      {
        content: [{ type: "text", text: sampleDiff }],
        details: { diff: sampleDiff },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: { path: "src/foo.ts" } },
    ).render(80).join("\n");
    expect(expandedDiffRendered).toContain("+const b = 2;");

    // Test tool component
    const toolComp = createToolComponent(
      tui,
      "edit_file",
      "call_123",
      { path: "src/foo.ts" },
      false,
    );
    toolComp.setArgsComplete();
    toolComp.updateResult(toolResultPayload(sampleDiff, false, { diff: sampleDiff }));

    const collapsedToolLines = toolComp.render(80);
    expect(collapsedToolLines).toHaveLength(3);
    expect(collapsedToolLines.join("\n")).not.toContain("+const b = 2;");

    toolComp.setExpanded(true);
    const compLines = toolComp.render(80).join("\n");
    expect(compLines).toContain("edit_file");
    expect(compLines).toContain("src/foo.ts");
    expect(compLines).toContain("+const b = 2;");
  });
});
