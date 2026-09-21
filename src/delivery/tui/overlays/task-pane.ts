import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "../rendering/adapter.ts";
import type { GoalRun, SubagentRun, ThebeAgent } from "../../../agent/index.ts";
import { chalk } from "../theme.ts";
import {
  activityGlyph,
  activitySummary,
  progressBar,
  progressPercent,
  subagentStatusGlyph,
} from "../display/activity.ts";
import { showSubagentDetail, summarizeSubagentTask } from "./subagent-detail.ts";

type TaskPaneOptions = {
  goal?: GoalRun;
  runs: SubagentRun[];
  onOpen: (run: SubagentRun) => void;
  onClose: () => void;
  getHeight?: () => number;
};

/** Grok Build-style roster: select a child, preview it, then open its transcript. */
export class TaskPaneOverlay implements Component {
  private goal?: GoalRun;
  private runs: SubagentRun[];
  private selected = 0;
  private visibleStart = 0;
  private visibleCount = 0;
  private promptExpanded = false;
  private readonly onOpen: (run: SubagentRun) => void;
  private readonly onClose: () => void;
  private readonly getHeight?: () => number;

  constructor(options: TaskPaneOptions) {
    this.goal = options.goal;
    this.runs = sortRuns(options.runs);
    this.onOpen = options.onOpen;
    this.onClose = options.onClose;
    this.getHeight = options.getHeight;
  }

  update(goal: GoalRun | undefined, runs: SubagentRun[]): void {
    const selectedId = this.runs[this.selected]?.runId;
    this.goal = goal;
    this.runs = sortRuns(runs);
    const retainedIndex = selectedId
      ? this.runs.findIndex((run) => run.runId === selectedId)
      : -1;
    this.selected = retainedIndex >= 0
      ? retainedIndex
      : Math.min(this.selected, Math.max(0, this.runs.length - 1));
  }

  render(width: number): string[] {
    const innerWidth = Math.max(0, width - 2);
    const targetHeight = Math.max(12, this.getHeight?.() ?? 24);
    const lines = [
      border("╭", "╮", innerWidth),
      headerLine(" Tasks", taskCountLabel(this.runs), "[x]", innerWidth),
      contentLine(goalLabel(this.goal), innerWidth, chalk.dim),
      contentLine(goalProgressLabel(this.goal), innerWidth, chalk.cyan),
      contentLine(" ↑/↓ or j/k select · Enter/click open · Ctrl+G/Esc close", innerWidth, chalk.dim),
      border("├", "┤", innerWidth),
      contentLine(` Subagents (${this.runs.length})`, innerWidth, chalk.bold),
    ];

    const maxListRows = Math.max(1, Math.min(5, targetHeight - 17));
    this.visibleStart = listWindowStart(this.selected, this.runs.length, maxListRows);
    const visibleRuns = this.runs.slice(
      this.visibleStart,
      this.visibleStart + maxListRows,
    );
    this.visibleCount = visibleRuns.length;

    if (visibleRuns.length === 0) {
      lines.push(contentLine(" No child runs yet", innerWidth, chalk.dim));
    } else {
      visibleRuns.forEach((run, offset) => {
        const index = this.visibleStart + offset;
        const selected = index === this.selected;
        const latest = run.activity?.at(-1);
        const row = `${selected ? " →" : "  "} ${subagentStatusGlyph(run.status)} ${run.profileName} · ${run.status} · ${run.turns}/${run.maxTurns} turns · ${latest ? activitySummary(latest) : "phase: starting"}${selected ? " · [open]" : ""}`;
        lines.push(
          contentLine(
            row,
            innerWidth,
            selected ? chalk.bold.cyan : statusStyle(run.status),
          ),
        );
      });
    }

    lines.push(border("├", "┤", innerWidth));
    const selectedRun = this.runs[this.selected];
    if (selectedRun) {
      lines.push(
        contentLine(
          ` Task prompt · P ${this.promptExpanded ? "collapse" : "expand"}`,
          innerWidth,
          chalk.bold,
        ),
      );
      if (this.promptExpanded) {
        const promptLines = wrapTextWithAnsi(selectedRun.task, Math.max(1, innerWidth - 2));
        for (const line of promptLines) {
          lines.push(contentLine(`  ${line}`, innerWidth, chalk.dim));
        }
      } else {
        lines.push(
          contentLine(`  ${summarizeSubagentTask(selectedRun.task)}`, innerWidth, chalk.dim),
        );
      }
      const latest = selectedRun.activity?.at(-1);
      lines.push(
        contentLine(
          ` ${activityGlyph.goal} Current activity · ${latest ? activitySummary(latest) : selectedRun.status}`,
          innerWidth,
          chalk.dim,
        ),
      );
      const response = selectedRun.responseText || selectedRun.result;
      lines.push(
        contentLine(
          response
            ? ` ${activityGlyph.result} Result · ${summarizeSubagentTask(response)}`
            : ` ${waitingGlyph(selectedRun.status)} Result · waiting for child output`,
          innerWidth,
          response ? chalk.green : chalk.dim,
        ),
      );
      if (this.goal?.summary || this.goal?.finalReport) {
        lines.push(
          contentLine(
            ` ${activityGlyph.result} Goal result · ${summarizeSubagentTask(this.goal.summary ?? this.goal.finalReport ?? "")}`,
            innerWidth,
            chalk.green,
          ),
        );
      }
    } else {
      lines.push(contentLine(" Start a Goal or subagent to inspect its work here.", innerWidth, chalk.dim));
      if (this.goal?.summary || this.goal?.finalReport) {
        lines.push(
          contentLine(
            ` ${activityGlyph.result} Goal result · ${summarizeSubagentTask(this.goal.summary ?? this.goal.finalReport ?? "")}`,
            innerWidth,
            chalk.green,
          ),
        );
      }
    }

    while (lines.length + 2 < targetHeight) {
      lines.push(contentLine("", innerWidth, chalk.dim));
    }
    lines.push(
      contentLine(" Enter/click open transcript · P prompt · q/Esc close · Ctrl+G toggle", innerWidth, chalk.dim),
    );
    lines.push(border("╰", "╯", innerWidth));
    return lines.slice(0, targetHeight);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+g") || matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.promptExpanded = false;
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(Math.max(0, this.runs.length - 1), this.selected + 1);
      this.promptExpanded = false;
      return;
    }
    if (data.toLowerCase() === "p") {
      this.promptExpanded = !this.promptExpanded;
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const run = this.runs[this.selected];
      if (run) this.onOpen(run);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (
      event.type === "click" &&
      event.y === 1 &&
      event.x >= Math.max(0, event.width - 6)
    ) {
      this.onClose();
      return { handled: true, render: true };
    }
    const rowIndex = event.y - 7;
    if (
      event.type === "click" &&
      rowIndex >= 0 &&
      rowIndex < this.visibleCount
    ) {
      const index = this.visibleStart + rowIndex;
      const run = this.runs[index];
      if (run) {
        this.selected = index;
        this.promptExpanded = false;
        this.onOpen(run);
      }
      return { handled: true, render: true };
    }
    return { handled: true };
  }
}

export function showTaskPane(
  tui: TUI,
  agent: ThebeAgent,
  parentSessionId: string,
  onDismiss?: () => void,
  onOpenRun?: (run: SubagentRun) => void,
  initialRuns: SubagentRun[] = [],
): () => void {
  let close = (): void => {};
  let closed = false;
  const readGoal = () => agent.getGoal(parentSessionId);
  let runs = initialRuns;
  const readRuns = () => runs;
  const pane = new TaskPaneOverlay({
    goal: readGoal(),
    runs: readRuns(),
    onOpen: (run) => {
      if (onOpenRun) onOpenRun(run);
      else showSubagentDetail(tui, agent, run);
    },
    onClose: () => close(),
    getHeight: () => tui.terminal.rows,
  });
  const handle = tui.showOverlay(pane, {
    width: "100%",
    maxHeight: "100%",
    anchor: "center",
  });
  const refresh = async (): Promise<void> => {
    try {
      runs = await agent.listSubagents(parentSessionId);
    } catch {
      return;
    }
    if (closed) return;
    pane.update(readGoal(), readRuns());
    tui.requestRender();
  };
  const unsubscribeRuns = agent.subscribeSubagents(parentSessionId, () => {
    void refresh();
  });
  const unsubscribeGoal = agent.subscribeGoal(parentSessionId, () => {
    void refresh();
  });
  close = () => {
    if (closed) return;
    closed = true;
    unsubscribeRuns();
    unsubscribeGoal();
    handle.hide();
    onDismiss?.();
    tui.requestRender();
  };
  void refresh();
  tui.requestRender();
  return close;
}

function sortRuns(runs: SubagentRun[]): SubagentRun[] {
  return [...runs].sort((a, b) => {
    const activeDifference = Number(isTerminal(a)) - Number(isTerminal(b));
    if (activeDifference !== 0) return activeDifference;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function isTerminal(run: SubagentRun): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "interrupted";
}

function listWindowStart(selected: number, total: number, size: number): number {
  if (total <= size) return 0;
  return Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
}

function taskCountLabel(runs: SubagentRun[]): string {
  const active = runs.filter((run) => !isTerminal(run)).length;
  return `${active} active · ${runs.length} total`;
}

function goalLabel(goal: GoalRun | undefined): string {
  if (!goal) return " No Goal · child runs remain available below";
  return ` Goal ${goal.status} · checkpoint ${goal.iteration}/${goal.maxIterations} · ${goal.goal}`;
}

function goalProgressLabel(goal: GoalRun | undefined): string {
  if (!goal) return ` ${activityGlyph.goal} Goal progress · no active Goal`;
  const percent = progressPercent(goal.iteration, goal.maxIterations);
  return ` ${activityGlyph.goal} Goal progress · ${goal.iteration}/${goal.maxIterations} checkpoints · ${percent}% ${progressBar(goal.iteration, goal.maxIterations, 10)}`;
}

function statusStyle(status: SubagentRun["status"]): (text: string) => string {
  if (status === "failed" || status === "interrupted") return chalk.red;
  if (status === "completed") return chalk.green;
  return chalk.dim;
}

function waitingGlyph(status: SubagentRun["status"]): string {
  if (status === "queued") return activityGlyph.queued;
  if (status === "failed" || status === "interrupted") return activityGlyph.error;
  if (status === "cancelled") return activityGlyph.cancelled;
  return activityGlyph.running;
}

function border(left: string, right: string, innerWidth: number): string {
  return chalk.dim(`${left}${"─".repeat(innerWidth)}${right}`);
}

function headerLine(
  title: string,
  status: string,
  close: string,
  innerWidth: number,
): string {
  const left = `${chalk.bold.cyan(title)} ${chalk.dim(`· ${status}`)}`;
  const gap = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(close));
  return `${chalk.dim("│")}${padAnsi(`${left}${" ".repeat(gap)}${chalk.bold.yellow(close)}`, innerWidth)}${chalk.dim("│")}`;
}

function contentLine(
  value: string,
  innerWidth: number,
  style: (text: string) => string,
): string {
  return `${chalk.dim("│")}${padAnsi(style(value), innerWidth)}${chalk.dim("│")}`;
}

function padAnsi(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
