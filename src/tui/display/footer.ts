import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { chalk } from "../theme.ts";

/**
 * Single-line footer using pi-tui `truncateToWidth` / `visibleWidth`.
 * Official `FooterComponent` is bound to Pi AgentSession, so Thebe keeps a
 * pad-to-width dock for model/context state and the latest summary status.
 */
export class FooterDock {
  private lines: string[] = [""];
  private summaryLine = "";

  setText(text: string): void {
    this.lines = text.length === 0 ? [""] : text.split("\n");
  }

  /** Keep the latest automatic summary in the dock, never in the transcript. */
  setSummary(summary?: string): void {
    this.summaryLine = formatSummaryLine(summary ?? "");
  }

  render(width: number): string[] {
    const lines = this.summaryLine
      ? [chalk.dim(`↳ ${this.summaryLine}`), ...this.lines]
      : this.lines;
    return lines.map((line) => {
      const truncated = truncateToWidth(line, width, "");
      const pad = Math.max(0, width - visibleWidth(truncated));
      return truncated + " ".repeat(pad);
    });
  }
  invalidate(): void {}
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
