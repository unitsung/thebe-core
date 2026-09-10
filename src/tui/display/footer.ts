import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Single-line footer using pi-tui `truncateToWidth` / `visibleWidth`.
 * Official `FooterComponent` is bound to Pi AgentSession, so Thebe keeps a
 * pad-to-width dock that only shows model • thinking.
 */
export class FooterDock {
  private lines: string[] = [""];
  setText(text: string): void {
    this.lines = text.length === 0 ? [""] : text.split("\n");
  }
  render(width: number): string[] {
    return this.lines.map((line) => {
      const truncated = truncateToWidth(line, width, "");
      const pad = Math.max(0, width - visibleWidth(truncated));
      return truncated + " ".repeat(pad);
    });
  }
  invalidate(): void {}
}
