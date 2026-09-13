import { describe, expect, it, vi } from "vitest";
import { visibleWidth, type TuiMouseEvent } from "../rendering/adapter.ts";
import { SubagentDetailOverlay } from "./subagent-detail.ts";
import type { SubagentRun } from "../../../agent/index.ts";

const run: SubagentRun = {
  runId: "child-1",
  parentSessionId: "parent-1",
  profileName: "goal-reviewer",
  task: "# Independent goal verification\nReview the worker checkpoint against the objective.",
  status: "running",
  turns: 2,
  maxTurns: 5,
  createdAt: "2026-09-12T00:00:00.000Z",
};

const click = (x: number): TuiMouseEvent => ({
  type: "click",
  button: "left",
  x,
  y: 1,
  screenX: x,
  screenY: 1,
  width: 80,
  height: 20,
  shift: false,
  alt: false,
  ctrl: false,
});

describe("SubagentDetailOverlay", () => {
  it("keeps a separate close control visible and clickable", () => {
    const close = vi.fn();
    const view = new SubagentDetailOverlay(run, close);
    const rendered = view.render(80).join("\n");

    expect(rendered).toContain("[x]");
    expect(rendered).not.toContain("Task: # Independent goal verification Review");
    expect(view.handleMouse(click(78))?.handled).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes from the keyboard without leaking a parent transcript", () => {
    const close = vi.fn();
    const view = new SubagentDetailOverlay(run, close);

    view.handleInput("q");

    expect(close).toHaveBeenCalledOnce();
    expect(view.render(80).every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("can occupy the whole terminal so parent output is not visible around it", () => {
    const view = new SubagentDetailOverlay(run, vi.fn(), () => 20);
    const lines = view.render(80);

    expect(lines).toHaveLength(20);
    expect(lines[0]).toContain("╭");
    expect(lines.at(-1)).toContain("╰");
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
  });

  it("replays the exact prompt, retained progress, and child response", () => {
    const completed: SubagentRun = {
      ...run,
      status: "completed",
      task: "Exact child prompt with acceptance criteria",
      responseText: "The child completed the requested implementation.",
      result: "The child completed the requested implementation.",
      activity: [
        {
          id: 1,
          at: "2026-09-13T00:00:01.000Z",
          kind: "thinking",
          title: "thinking",
          detail: "Inspecting the affected files",
        },
        {
          id: 2,
          at: "2026-09-13T00:00:02.000Z",
          kind: "tool",
          title: "read completed",
        },
      ],
    };
    const view = new SubagentDetailOverlay(completed, vi.fn(), () => 30);
    view.handleInput("p");
    view.handleInput("\u0014");
    view.handleInput("home");
    const rendered = view.render(100).join("\n");

    expect(rendered).toContain("Prompt");
    expect(rendered).toContain("Exact child prompt with acceptance criteria");
    expect(rendered).toContain("Progress");
    expect(rendered).toContain("Inspecting the affected files");
    expect(rendered).toContain("Child response");
    expect(rendered).toContain("The child completed the requested implementation.");
  });

  it("turns image Markdown and bare URLs in the child response into links", () => {
    const completed: SubagentRun = {
      ...run,
      status: "completed",
      responseText: [
        "![portrait](https://example.com/portrait.png)",
        "More images: https://example.com/gallery",
      ].join("\n"),
    };
    const view = new SubagentDetailOverlay(completed, vi.fn(), () => 30);
    const rendered = view.render(100).join("\n");

    expect(rendered).toContain("portrait");
    expect(rendered).toContain("https://example.com/portrait.png");
    expect(rendered).toContain("https://example.com/gallery");
    expect(rendered).not.toContain("![portrait]");
  });

  it("formats tool calls as a compact labeled timeline", () => {
    const completed: SubagentRun = {
      ...run,
      status: "completed",
      activity: [
        {
          id: 1,
          at: "2026-09-13T00:00:01.000Z",
          kind: "tool",
          title: "read started",
          detail: '{"path":"/workspace/package.json"}',
        },
        {
          id: 2,
          at: "2026-09-13T00:00:02.000Z",
          kind: "tool",
          title: "read completed",
          detail: Array.from({ length: 20 }, (_, index) => `line-${index} ${"x".repeat(300)}`).join("\n"),
        },
      ],
    };
    const view = new SubagentDetailOverlay(completed, vi.fn(), () => 100);
    const folded = view.render(100).join("\n");

    expect(folded).toContain("⚙ read · started · Ctrl+O");
    expect(folded).toContain("⚙ read · completed · Ctrl+O");
    expect(folded).not.toContain("Input:");
    expect(folded).not.toContain("Output:");

    view.handleInput("\u000f");
    const expanded = view.render(100).join("\n");
    expect(expanded).toContain("Input: path=/workspace/package.json");
    expect(expanded).not.toContain('{"path":"/workspace/package.json"}');
    expect(expanded).toContain("Output:");
    expect(expanded).not.toContain("line-19");
  });

  it("folds prompt, thinking, and tool details while keeping progress and result visible", () => {
    const completed: SubagentRun = {
      ...run,
      status: "completed",
      turns: 2,
      maxTurns: 8,
      task: "Implement the task pane\nSECRET PROMPT DETAIL",
      responseText: "Final child result remains visible.",
      activity: [
        {
          id: 1,
          at: "2026-09-13T00:00:01.000Z",
          kind: "thinking",
          title: "thinking",
          detail: "SECRET THINKING DETAIL",
        },
        {
          id: 2,
          at: "2026-09-13T00:00:02.000Z",
          kind: "tool",
          title: "read completed",
          toolName: "read",
          phase: "completed",
          detailKind: "output",
          detail: "SECRET TOOL OUTPUT",
        },
      ],
    };
    const view = new SubagentDetailOverlay(completed, vi.fn(), () => 30);

    const folded = view.render(100).join("\n");
    expect(folded).toContain("▸ Prompt");
    expect(folded).toContain("◆ Progress");
    expect(folded).toContain("2/8 turns");
    expect(folded).toContain("25%");
    expect(folded).toContain("◇ Thinking");
    expect(folded).toContain("Ctrl+T");
    expect(folded).toContain("⚙ read · completed");
    expect(folded).toContain("Ctrl+O");
    expect(folded).toContain("✓ Result");
    expect(folded).toContain("Final child result remains visible.");
    expect(folded).not.toContain("SECRET PROMPT DETAIL");
    expect(folded).not.toContain("SECRET THINKING DETAIL");
    expect(folded).not.toContain("SECRET TOOL OUTPUT");

    view.handleInput("p");
    view.handleInput("\u0014");
    view.handleInput("\u000f");
    const expanded = view.render(100).join("\n");
    expect(expanded).toContain("SECRET PROMPT DETAIL");
    expect(expanded).toContain("SECRET THINKING DETAIL");
    expect(expanded).toContain("SECRET TOOL OUTPUT");
  });
});
