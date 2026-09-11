/**
 * Transcript widgets on official Pi components:
 * ToolExecutionComponent (fold + highlight + diff), Loader elapsed "Working Ns".
 */
import {
  Loader,
  Markdown,
  Text,
  truncateToWidth,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  highlightCode,
  renderDiff,
  ToolExecutionComponent,
  type Theme,
} from "../../runtime/pi/official-ui.ts";
import { chalk } from "../theme.ts";
import { stashMarkdownSource } from "../display/markdown-source.ts";

export class ElapsedWorking extends Loader {
  private startedAt = Date.now();
  private tick: ReturnType<typeof setInterval> | undefined;
  private label = "Working";

  constructor(tui: TUI) {
    super(
      tui,
      (s) => chalk.cyan(s),
      (s) => chalk.dim(s),
      "Working 0s",
    );
    this.tick = setInterval(() => this.refresh(), 1000);
  }

  setLabel(label: string): void {
    this.label = label;
    this.refresh();
  }

  getElapsedSeconds(): number {
    return Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
  }

  private refresh(): void {
    const seconds = this.getElapsedSeconds();
    this.setMessage(`${this.label} ${seconds}s`);
  }

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

  constructor(hidden: boolean) {
    this.hidden = hidden;
  }

  append(delta: string): void {
    this.body += delta;
  }

  finish(seconds?: number): void {
    if (!this.finished) {
      this.finished = true;
      this.durationSeconds =
        seconds ?? Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    }
  }

  isFinished(): boolean {
    return this.finished;
  }

  getDurationSeconds(): number {
    if (this.durationSeconds !== undefined) {
      return this.durationSeconds;
    }
    return Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  isEmpty(): boolean {
    return this.body.trim().length === 0;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.isEmpty()) {
      return [];
    }
    const sec = this.getDurationSeconds();
    if (this.hidden) {
      const label = this.finished
        ? `  thought for ${sec}s · Ctrl+T`
        : `  Thinking (${sec}s)... · Ctrl+T`;
      return [truncateToWidth(chalk.dim(label), width, "")];
    }
    const header = this.finished
      ? chalk.dim(`  thought for ${sec}s · Ctrl+T`)
      : chalk.dim(`  Thinking (${sec}s)... · Ctrl+T`);
    const lines = this.body.replace(/\s+$/, "").split("\n");
    const styled = lines.map((line) => chalk.italic(chalk.dim(`  ${line}`)));
    return [
      truncateToWidth(header, width, ""),
      ...styled.map((l) => truncateToWidth(l, width, "")),
    ];
  }
}

function formatToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") {
    return typeof args === "string" ? args : "";
  }
  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") {
    return record.command;
  }
  if (typeof record.path === "string") {
    return record.path;
  }
  if (typeof record.file_path === "string") {
    return record.file_path;
  }
  if (typeof record.TargetFile === "string") {
    return record.TargetFile;
  }
  if (typeof record.pattern === "string") {
    return record.path ? `${record.pattern} in ${record.path}` : record.pattern;
  }
  if (typeof record.query === "string") {
    return record.query;
  }
  if (typeof record.prompt === "string") {
    return record.prompt.length > 80 ? `${record.prompt.slice(0, 77)}...` : record.prompt;
  }
  if (typeof record.url === "string") {
    return record.url;
  }
  if (typeof record.Url === "string") {
    return record.Url;
  }
  for (const [, val] of Object.entries(record)) {
    if (typeof val === "string" && val.trim()) {
      return val.length > 80 ? `${val.slice(0, 77)}...` : val;
    }
  }
  return "";
}

function pathFromArgs(args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  const record = args as Record<string, unknown>;
  if (typeof record.path === "string") {
    return record.path;
  }
  if (typeof record.file_path === "string") {
    return record.file_path;
  }
  if (typeof record.TargetFile === "string") {
    return record.TargetFile;
  }
  return "";
}

function looksLikeDiff(text: string): boolean {
  return /^(diff --git |--- |\+\+\+ )/m.test(text) || text.includes("\n@@ ");
}

function languageFromPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) {
    return undefined;
  }
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    json: "json",
    md: "markdown",
    sh: "bash",
    bash: "bash",
  };
  return map[ext];
}

function resultText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export function createToolRenderers(toolName: string) {
  return {
    renderCall(args: unknown, theme: Theme) {
      const title = theme.fg("toolTitle", theme.bold(toolName));
      const argStr = formatToolArgs(toolName, args);
      const rest = argStr ? ` ${theme.fg("accent", argStr)}` : "";
      return new Text(`${title}${rest}`, 0, 0);
    },
    renderResult(
      result: {
        content: Array<{ type: string; text?: string }>;
        details?: { diff?: string };
      },
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context?: { args?: unknown },
    ) {
      if (options.isPartial && !result.content?.length) {
        return new Text(theme.fg("warning", "working"), 0, 0);
      }
      const text = resultText(result);
      if (!text.trim()) {
        return new Text("", 0, 0);
      }
      const diff =
        typeof result.details?.diff === "string"
          ? result.details.diff
          : looksLikeDiff(text)
            ? text
            : undefined;
      if (diff) {
        const lines = renderDiff(diff).split("\n");
        const shown = options.expanded ? lines : lines.slice(0, 12);
        const remaining = lines.length - shown.length;
        const extra =
          remaining > 0
            ? `\n${theme.fg("muted", `... ${remaining} more lines · Ctrl+O`)}`
            : "";
        return new Text(`${shown.join("\n")}${extra}`, 0, 0);
      }
      const lang = languageFromPath(pathFromArgs(context?.args));
      const lines = (
        lang ? highlightCode(text, lang).join("\n") : text
      ).split("\n");
      const shown = options.expanded ? lines : lines.slice(0, 10);
      const remaining = lines.length - shown.length;
      const extra =
        remaining > 0
          ? `\n${theme.fg("muted", `... ${remaining} more lines · Ctrl+O`)}`
          : "";
      return new Text(`${shown.join("\n")}${extra}`, 0, 0);
    },
  };
}

export function makeReplyMarkdown(
  text: string,
  theme: MarkdownTheme,
): Markdown {
  const md = new Markdown(text, 1, 1, {
    ...theme,
    highlightCode: (code, lang) => highlightCode(code, lang),
  });
  stashMarkdownSource(md, text);
  return md;
}

export function createToolComponent(
  tui: TUI,
  toolName: string,
  toolCallId: string,
  args: unknown,
  expanded: boolean,
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    toolName,
    toolCallId,
    args ?? {},
    undefined,
    createToolRenderers(toolName),
    tui,
    process.cwd(),
  );
  component.setExpanded(expanded);
  component.markExecutionStarted();
  return component;
}

export function toolResultPayload(
  text: string,
  isError: boolean,
  details?: unknown,
): {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text }],
    details,
    isError,
  };
}
