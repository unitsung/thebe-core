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

  private refresh(): void {
    const seconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
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

  constructor(hidden: boolean) {
    this.hidden = hidden;
  }

  append(delta: string): void {
    this.body += delta;
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
    if (this.hidden) {
      return [truncateToWidth(chalk.dim("  reasoning hidden · Ctrl+T"), width, "")];
    }
    const lines = this.body.replace(/\s+$/, "").split("\n");
    const styled = lines.map((line) => chalk.italic(chalk.dim(line)));
    return styled.map((line) => truncateToWidth(`  ${line}`, width, ""));
  }
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
      const path = pathFromArgs(args);
      const rest = path ? ` ${theme.fg("accent", path)}` : "";
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
