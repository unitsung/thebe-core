import {
  truncateToWidth,
  visibleWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "../rendering/adapter.ts";
import { chalk } from "../theme.ts";

/**
 * Single-line footer using pi-tui `truncateToWidth` / `visibleWidth`.
 * Official `FooterComponent` is bound to Pi AgentSession, so Thebe keeps a
 * pad-to-width dock for model/context state and the latest summary status.
 */
export class FooterDock {
  private lines: string[] = [""];
  private summaryLine = "";
  private taskLine = "";
  private openTasks?: () => void;

  setText(text: string): void {
    this.lines = text.length === 0 ? [""] : text.split("\n");
  }

  /** Keep the latest automatic summary in the dock, never in the transcript. */
  setSummary(summary?: string): void {
    this.summaryLine = formatSummaryLine(summary ?? "");
  }

  /** Persistent, clickable task roster entry; unlike transcript notices it cannot scroll away. */
  setTaskStatus(status?: string, onOpen?: () => void): void {
    this.taskLine = status?.trim() ?? "";
    this.openTasks = this.taskLine ? onOpen : undefined;
  }

  render(width: number): string[] {
    const lines = [
      ...(this.taskLine
        ? [`${chalk.cyan("◆ Tasks")} ${chalk.dim(`${this.taskLine} · click/Ctrl+G open`)}`]
        : []),
      ...(this.summaryLine ? [chalk.dim(`↳ ${this.summaryLine}`)] : []),
      ...this.lines,
    ];
    return lines.map((line) => {
      const truncated = truncateToWidth(line, width, "");
      const pad = Math.max(0, width - visibleWidth(truncated));
      return truncated + " ".repeat(pad);
    });
  }
  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.taskLine && event.type === "click" && event.y === 0) {
      this.openTasks?.();
      return { handled: true, render: true };
    }
    return undefined;
  }
}

/** Flatten a generated Markdown summary to one calm, single-line status. */
export function formatSummaryLine(summary: string): string {
  const flattened = summary
    .replace(/\s+/g, " ")
    .replace(/[\*_`#>]/g, "")
    .trim();
  if (!flattened) return "";

  const firstSentence = flattened.match(/^(.+?[。！？!?](?:\s|$)|.+$)/)?.[1] ?? flattened;
  const sentence = firstSentence.trim();
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}
