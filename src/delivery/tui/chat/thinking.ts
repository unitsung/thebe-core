import { Loader, truncateToWidth, type TUI } from "../rendering/adapter.ts";
import { chalk } from "../theme.ts";
import { activityGlyph } from "../display/activity.ts";

export class ElapsedWorking extends Loader {
  private startedAt = Date.now();
  private tick: ReturnType<typeof setInterval> | undefined;
  private label = "Working";

  constructor(tui: TUI) {
    super(tui, (text) => chalk.cyan(text), (text) => chalk.dim(text), "Working 0s");
    this.tick = setInterval(() => this.refresh(), 1000);
  }

  setLabel(label: string): void { this.label = label; this.refresh(); }
  getElapsedSeconds(): number { return Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)); }
  private refresh(): void { this.setMessage(`${this.label} ${this.getElapsedSeconds()}s`); }
  override stop(): void {
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = undefined;
    }
    super.stop();
  }
}

export class ThinkingBlock {
  private body = "";
  hidden: boolean;
  private startedAt = Date.now();
  private finished = false;
  private durationSeconds?: number;

  constructor(hidden = true) { this.hidden = hidden; }
  append(delta: string): void { this.body += delta; }
  finish(seconds?: number): void {
    if (!this.finished) {
      this.finished = true;
      this.durationSeconds = seconds ?? Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    }
  }
  isFinished(): boolean { return this.finished; }
  getDurationSeconds(): number {
    return this.durationSeconds ?? Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
  }
  setHidden(hidden: boolean): void { this.hidden = hidden; }
  isEmpty(): boolean { return this.body.trim().length === 0; }
  invalidate(): void {}

  render(width: number): string[] {
    if (this.isEmpty()) {
      return this.finished ? [] : [truncateToWidth(chalk.dim(`  ${activityGlyph.thinking} Thinking... · Ctrl+T`), width, "")];
    }
    const sec = this.getDurationSeconds();
    const label = this.finished
      ? `  ${activityGlyph.thinking} thought for ${sec}s · Ctrl+T`
      : `  ${activityGlyph.thinking} Thinking (${sec}s)... · Ctrl+T`;
    if (this.hidden) return [truncateToWidth(chalk.dim(label), width, "")];
    const lines = this.body.replace(/\s+$/, "").split("\n");
    return [
      truncateToWidth(chalk.dim(label), width, ""),
      ...lines.map((line) => truncateToWidth(chalk.italic(chalk.dim(`  ${line}`)), width, "")),
    ];
  }
}
