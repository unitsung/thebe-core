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
import type { ThebeAgent, SubagentRun, SubagentUpdate } from "../../../agent/index.ts";
import { chalk } from "../theme.ts";
import { activityGlyph } from "../display/activity.ts";
import { wrapTerminalLinks } from "../display/markdown/links.ts";
import {
  currentPhase,
  latestActivity,
  progressLabel,
  renderActivity,
  resultWaitingGlyph,
  singleLine,
  statusIcon,
} from "./subagent-activity.ts";

/** Full retained child transcript: exact prompt, progress trace, and response. */
export class SubagentDetailOverlay implements Component {
  private run: SubagentRun;
  private readonly onClose: () => void;
  private readonly getHeight?: () => number;
  private scrollOffset = Number.MAX_SAFE_INTEGER;
  private pageSize = 10;
  private followTail = true;
  private promptExpanded = false;
  private thinkingExpanded = false;
  private toolsExpanded = false;

  constructor(initialRun: SubagentRun, onClose: () => void, getHeight?: () => number) {
    this.run = initialRun;
    this.onClose = onClose;
    this.getHeight = getHeight;
  }

  update(update: SubagentUpdate): void { this.run = update.run; }

  render(width: number): string[] {
    const innerWidth = Math.max(0, width - 2);
    const targetHeight = Math.max(10, this.getHeight?.() ?? 24);
    const bodyHeight = Math.max(1, targetHeight - 6);
    this.pageSize = bodyHeight;
    const body = this.renderTranscript(Math.max(1, innerWidth - 2));
    const maxOffset = Math.max(0, body.length - bodyHeight);
    const offset = this.followTail ? maxOffset : Math.max(0, Math.min(this.scrollOffset, maxOffset));
    this.scrollOffset = offset;
    const lines = [
      border("╭", "╮", innerWidth),
      this.headerLine(innerWidth),
      contentLine(` Parent ${this.run.parentSessionId.slice(0, 8)} · ${latestActivity(this.run)} · ${offset + 1}-${Math.min(body.length, offset + bodyHeight)}/${body.length}`, innerWidth, chalk.dim),
      border("├", "┤", innerWidth),
      ...body.slice(offset, offset + bodyHeight).map((line) => contentLine(` ${line}`, innerWidth, (value) => value)),
    ];
    while (lines.length + 2 < targetHeight) lines.push(contentLine("", innerWidth, chalk.dim));
    lines.push(contentLine(" P prompt · Ctrl+T thinking · Ctrl+O tools · ↑/↓ scroll · Esc/q back", innerWidth, chalk.dim));
    lines.push(border("╰", "╯", innerWidth));
    return lines.slice(0, targetHeight);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, "escape")) { this.onClose(); return; }
    if (matchesKey(data, "up") || data === "k") { this.followTail = false; this.scrollOffset = Math.max(0, this.scrollOffset - 1); return; }
    if (matchesKey(data, "down") || data === "j") { this.followTail = false; this.scrollOffset += 1; return; }
    if (matchesKey(data, "pageUp")) { this.followTail = false; this.scrollOffset = Math.max(0, this.scrollOffset - this.pageSize); return; }
    if (matchesKey(data, "pageDown")) { this.followTail = false; this.scrollOffset += this.pageSize; return; }
    if (matchesKey(data, "home")) { this.followTail = false; this.scrollOffset = 0; return; }
    if (matchesKey(data, "end")) { this.followTail = true; this.scrollOffset = Number.MAX_SAFE_INTEGER; return; }
    if (data.toLowerCase() === "p") { this.promptExpanded = !this.promptExpanded; this.followTail = true; return; }
    if (matchesKey(data, "ctrl+t")) { this.thinkingExpanded = !this.thinkingExpanded; this.followTail = true; return; }
    if (matchesKey(data, "ctrl+o")) { this.toolsExpanded = !this.toolsExpanded; this.followTail = true; }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "click" && event.y === 1 && event.x >= Math.max(0, event.width - 6)) {
      this.onClose();
      return { handled: true, render: true };
    }
    if (event.type === "wheel") {
      this.followTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset + (event.wheelDelta ?? 0));
      return { handled: true, render: true };
    }
    return { handled: true };
  }

  private headerLine(innerWidth: number): string {
    const closeControl = "[x]";
    const available = Math.max(1, innerWidth - visibleWidth(closeControl) - 1);
    const title = truncateToWidth(` ${statusIcon(this.run.status)} ${this.run.profileName} · ${this.run.status} · ${this.run.turns}/${this.run.maxTurns} turns `, available, "");
    const styledTitle = chalk.bold.cyan(title);
    const gap = Math.max(1, innerWidth - visibleWidth(styledTitle) - visibleWidth(closeControl));
    return `${chalk.dim("│")}${padAnsi(`${styledTitle}${" ".repeat(gap)}${chalk.bold.yellow(closeControl)}`, innerWidth)}${chalk.dim("│")}`;
  }

  private renderTranscript(width: number): string[] {
    const lines: string[] = [chalk.bold.cyan(`${this.promptExpanded ? activityGlyph.promptExpanded : activityGlyph.promptCollapsed} Prompt · ${summarizeSubagentTask(this.run.task)} · P ${this.promptExpanded ? "collapse" : "expand"}`)];
    if (this.promptExpanded) lines.push(...wrapTerminalLinks(this.run.task, width, chalk.reset));
    lines.push("");
    lines.push(chalk.bold.cyan(`${activityGlyph.goal} Progress · ${progressLabel(this.run)} · phase: ${currentPhase(this.run)}`));
    const activity = this.run.activity ?? [];
    if (!activity.length) lines.push(chalk.dim("No progress events retained yet."));
    else for (const entry of activity) lines.push(...renderActivity(entry, width, this.thinkingExpanded, this.toolsExpanded));
    lines.push("");
    const response = this.run.responseText || this.run.result;
    lines.push(chalk.bold.green(`${response ? activityGlyph.result : resultWaitingGlyph(this.run.status)} Result · Child response`));
    if (response) lines.push(...wrapTerminalLinks(response, width, chalk.green));
    else lines.push(chalk.dim("Waiting for child output…"));
    if (this.run.error) {
      lines.push("");
      lines.push(chalk.bold.red("Error"));
      lines.push(...wrapTerminalLinks(this.run.error, width, chalk.red));
    }
    return lines;
  }
}

export function showSubagentDetail(tui: TUI, agent: ThebeAgent, initialRun: SubagentRun): () => void {
  let closeOverlay = (): void => {};
  let closed = false;
  const component = new SubagentDetailOverlay(agent.getSubagent(initialRun.runId) ?? initialRun, () => closeOverlay(), () => tui.terminal.rows);
  const handle = tui.showOverlay(component, { width: "100%", maxHeight: "100%", anchor: "center" });
  const unsubscribe = agent.subscribeSubagent(initialRun.runId, (update) => { component.update(update); tui.requestRender(); });
  closeOverlay = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    handle.hide();
    tui.requestRender();
  };
  tui.requestRender();
  return closeOverlay;
}

export function summarizeSubagentTask(task: string): string {
  const heading = task.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  const firstLine = task.split(/\r?\n/).find((line) => line.trim())?.trim();
  return singleLine(heading || firstLine || task, 140);
}

function border(left: string, right: string, innerWidth: number): string { return chalk.dim(`${left}${"─".repeat(innerWidth)}${right}`); }

function contentLine(value: string, innerWidth: number, style: (text: string) => string): string {
  return `${chalk.dim("│")}${padAnsi(style(value), innerWidth)}${chalk.dim("│")}`;
}

function padAnsi(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
