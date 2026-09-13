/**
 * The only terminal-rendering adapter used by the TUI.
 *
 * Keeping the concrete terminal toolkit here leaves the chat and command
 * modules dependent on Thebe's small rendering vocabulary.  In particular,
 * the Agent compatibility surface never needs to know which terminal
 * toolkit is installed.
 */
import { spawn } from "node:child_process";
import { Chalk } from "chalk";
import {
  Container,
  Loader,
  Text,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

export * from "@earendil-works/pi-tui";

const chalk = new Chalk({ level: 3 });

export type ThemeColor =
  | "accent"
  | "muted"
  | "warning"
  | "error"
  | "success"
  | "toolTitle"
  | "toolOutput";

/** Small, stable theme interface consumed by transcript renderers. */
export class Theme {
  constructor(readonly name: string = "dark") {}

  fg(color: ThemeColor, text: string): string {
    switch (color) {
      case "accent":
        return this.name === "light" ? chalk.blue(text) : chalk.cyan(text);
      case "warning":
        return chalk.yellow(text);
      case "error":
        return chalk.red(text);
      case "success":
        return chalk.green(text);
      case "toolTitle":
        return this.name === "light" ? chalk.blue(text) : chalk.cyan(text);
      case "toolOutput":
      case "muted":
        return chalk.dim(text);
    }
  }

  bold(text: string): string {
    return chalk.bold(text);
  }

  italic(text: string): string {
    return chalk.italic(text);
  }

  underline(text: string): string {
    return chalk.underline(text);
  }

  strikethrough(text: string): string {
    return chalk.strikethrough(text);
  }
}

const themes = new Map<string, Theme>();
let activeThemeName = "dark";

export function getRenderingTheme(name = "dark"): Theme {
  const normalized = name === "light" ? "light" : "dark";
  let result = themes.get(normalized);
  if (!result) {
    result = new Theme(normalized);
    themes.set(normalized, result);
  }
  return result;
}

/** Kept as a rendering vocabulary name for existing pure transcript tests. */
export const getPiThemeInstance = getRenderingTheme;

/** Theme initialization is intentionally local to the rendering adapter. */
export function initTheme(name: string, _watch = false): void {
  activeThemeName = name === "light" ? "light" : "dark";
}

export function highlightCode(code: string, _language?: string): string[] {
  return code.split("\n");
}

export function renderDiff(diff: string): string {
  return diff;
}

export type ToolRenderResult = {
  content: Array<{ type: string; text?: string }>;
  details?: any;
  isError: boolean;
};

export type ToolRenderer = {
  renderShell?: "default" | "self";
  renderCall?: (args: unknown, theme: Theme) => Component;
  renderResult?: (
    result: ToolRenderResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context?: { args?: unknown },
  ) => Component;
};

/** Compact tool transcript widget used by event and history presenters. */
export class ToolExecutionComponent extends Container {
  private args: unknown;
  private result: ToolRenderResult | undefined;
  private partial = false;
  private expanded = false;
  private started = false;
  private argsComplete = false;

  constructor(
    private readonly toolName: string,
    private readonly toolCallId: string,
    args: unknown,
    _options: unknown,
    private readonly renderer: ToolRenderer | undefined,
    private readonly tui: TUI,
    private readonly cwd: string,
  ) {
    super();
    this.args = args;
  }

  updateArgs(args: unknown): void {
    this.args = args;
    this.invalidate();
  }

  markExecutionStarted(): void {
    this.started = true;
    this.invalidate();
  }

  setArgsComplete(): void {
    this.argsComplete = true;
    this.invalidate();
  }

  updateResult(result: ToolRenderResult, isPartial = false): void {
    this.result = result;
    this.partial = isPartial;
    this.invalidate();
    this.tui.requestRender();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.invalidate();
  }

  render(width: number): string[] {
    const theme = getRenderingTheme(activeThemeName);
    const call = this.renderer?.renderCall?.(this.args, theme);
    const lines = call?.render(width) ?? [
      theme.fg("toolTitle", `${this.toolName} · ${this.toolCallId}`),
    ];
    if (!this.result || !this.renderer?.renderResult) {
      return lines;
    }
    const result = this.renderer.renderResult(
      this.result,
      { expanded: this.expanded, isPartial: this.partial },
      theme,
      { args: this.args },
    );
    const renderedResult = result.render(width);
    // Leave the same breathing row as the previous interactive renderer.
    return this.expanded ? [...lines, ...renderedResult] : [...lines, ...renderedResult, ""];
  }

  // These fields are part of the adapter's diagnostic surface and make it
  // clear that this widget is a renderer, never a tool executor.
  get executionStarted(): boolean {
    return this.started;
  }

  get hasCompleteArgs(): boolean {
    return this.argsComplete;
  }

  get workingDirectory(): string {
    return this.cwd;
  }
}

/** Compact shell command renderer; execution remains in the Agent/session flow. */
export class BashExecutionComponent extends Container {
  private readonly output: string[] = [];
  private complete = false;
  private exitCode: number | undefined;
  private cancelled = false;
  private readonly loader: Loader;

  constructor(
    private readonly command: string,
    tui: TUI,
    private readonly excludeFromContext = false,
  ) {
    super();
    this.loader = new Loader(
      tui,
      (value) => chalk.cyan(value),
      (value) => chalk.dim(value),
      "Working 0s",
    );
    this.loader.start();
  }

  appendOutput(chunk: string): void {
    this.output.push(chunk);
    this.invalidate();
  }

  setComplete(exitCode: number | undefined, cancelled: boolean): void {
    this.complete = true;
    this.exitCode = exitCode;
    this.cancelled = cancelled;
    this.loader.stop();
    this.invalidate();
  }

  setExpanded(_expanded: boolean): void {
    this.invalidate();
  }

  render(width: number): string[] {
    const prefix = this.excludeFromContext ? "!!" : "!";
    const status = this.complete
      ? this.cancelled
        ? "cancelled"
        : this.exitCode === 0 || this.exitCode === undefined
          ? "done"
          : `exit ${this.exitCode}`
      : "running";
    const output = this.output.join("").trimEnd();
    const rows = [`${chalk.green(`${prefix}${this.command}`)} · ${chalk.dim(status)}`];
    if (output) rows.push(...new Text(output, 0, 0).render(width));
    return rows;
  }
}

export async function copyToClipboard(text: string): Promise<void> {
  const command = process.platform === "darwin"
    ? "pbcopy"
    : process.platform === "win32"
      ? "clip"
      : "xclip";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [], { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("clipboard unavailable")));
    child.stdin.end(text);
  });
}
