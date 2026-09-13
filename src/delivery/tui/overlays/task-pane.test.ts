import { describe, expect, it, vi } from "vitest";
import type { GoalRun, SubagentRun } from "../../../agent/index.ts";
import { TaskPaneOverlay } from "./task-pane.ts";

const child: SubagentRun = {
  runId: "child-1",
  parentSessionId: "parent-1",
  profileName: "goal-worker",
  task: "Read the repository and implement the requested interaction.",
  status: "running",
  turns: 2,
  maxTurns: 8,
  createdAt: "2026-09-13T00:00:00.000Z",
};

const goal: GoalRun = {
  thebeSessionId: "parent-1",
  goal: "Upgrade Goal and subagent interaction",
  maxIterations: 8,
  iteration: 1,
  status: "running",
  createdAt: "2026-09-13T00:00:00.000Z",
  subagentRunIds: ["child-1"],
  activeSubagent: child,
};

describe("TaskPaneOverlay", () => {
  it("makes tasks discoverable, previews the prompt, and opens the selected child", () => {
    const open = vi.fn();
    const pane = new TaskPaneOverlay({
      goal,
      runs: [child],
      onOpen: open,
      onClose: vi.fn(),
      getHeight: () => 24,
    });

    const rendered = pane.render(100).join("\n");
    expect(rendered).toContain("Tasks");
    expect(rendered).toContain("Goal running · checkpoint 1/8");
    expect(rendered).toContain("goal-worker · running · 2/8 turns");
    expect(rendered).toContain("Task prompt");
    expect(rendered).toContain("Read the repository and implement the requested interaction.");
    expect(rendered).toContain("Enter/click open");

    pane.handleInput("\r");
    expect(open).toHaveBeenCalledWith(child);
  });

  it("opens a visibly selectable child row with one click", () => {
    const open = vi.fn();
    const pane = new TaskPaneOverlay({
      goal,
      runs: [child],
      onOpen: open,
      onClose: vi.fn(),
      getHeight: () => 24,
    });
    pane.render(100);

    pane.handleMouse({
      type: "click",
      button: "left",
      x: 10,
      y: 7,
      screenX: 10,
      screenY: 7,
      width: 100,
      height: 24,
      shift: false,
      alt: false,
      ctrl: false,
    });

    expect(open).toHaveBeenCalledWith(child);
  });
});
