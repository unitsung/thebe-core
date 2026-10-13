import { Text, truncateToWidth, type TUI } from "../rendering/adapter.ts";
import {
  highlightCode,
  renderDiff,
  ToolExecutionComponent,
  type Theme,
} from "../rendering/adapter.ts";
import { activityGlyph } from "../display/activity.ts";

class SingleLineText {
  constructor(private readonly text: string) {}
  render(width: number): string[] {
    return [truncateToWidth(this.text, width, "")];
  }
  invalidate(): void {}
}

function formatToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object")
    return typeof args === "string" ? args : "";
  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  if (typeof record.path === "string") return record.path;
  if (typeof record.file_path === "string") return record.file_path;
  if (typeof record.TargetFile === "string") return record.TargetFile;
  if (typeof record.pattern === "string")
    return record.path ? `${record.pattern} in ${record.path}` : record.pattern;
  if (typeof record.query === "string") return record.query;
  if (typeof record.prompt === "string")
    return record.prompt.length > 80
      ? `${record.prompt.slice(0, 77)}...`
      : record.prompt;
  if (typeof record.url === "string") return record.url;
  if (typeof record.Url === "string") return record.Url;
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim())
      return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  return "";
}

function pathFromArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "TargetFile"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}

function looksLikeDiff(text: string): boolean {
  return /^(diff --git |--- |\+\+\+ )/m.test(text) || text.includes("\n@@ ");
}

function languageFromPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  return {
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
  }[ext];
}

function resultText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function compactToolResult(text: string, lineCount: number): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? "";
  const clipped =
    firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
  const suffix: string[] = [];
  if (firstLine.length > clipped.length) suffix.push("more");
  const remaining = Math.max(0, lineCount - 1);
  if (remaining > 0) suffix.push(`${remaining} more lines`);
  if (suffix.length) suffix.push("Ctrl+O");
  return `${clipped}${suffix.length ? ` · ${suffix.join(" · ")}` : ""}`;
}

export function createToolRenderers(toolName: string) {
  return {
    renderShell: "self" as const,
    renderCall(args: unknown, theme: Theme) {
      const title = theme.fg(
        "toolTitle",
        theme.bold(`${activityGlyph.tool} ${toolName}`)
      );
      const argStr = formatToolArgs(toolName, args);
      return new SingleLineText(
        `${title}${argStr ? ` ${theme.fg("accent", argStr)}` : ""}${theme.fg("muted", " · Ctrl+O")}`
      );
    },
    renderResult(
      result: {
        content: Array<{ type: string; text?: string }>;
        details?: { diff?: string };
      },
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context?: { args?: unknown }
    ) {
      if (options.isPartial)
        return new SingleLineText(theme.fg("warning", "working…"));
      const text = resultText(result);
      if (!text.trim()) return new Text("", 0, 0);
      const diff =
        typeof result.details?.diff === "string"
          ? result.details.diff
          : looksLikeDiff(text)
            ? text
            : undefined;
      if (diff) {
        const lines = renderDiff(diff).split("\n");
        return options.expanded
          ? new Text(lines.join("\n"), 0, 0)
          : new SingleLineText(
              theme.fg("muted", compactToolResult(diff, lines.length))
            );
      }
      const lang = languageFromPath(pathFromArgs(context?.args));
      const lines = (lang ? highlightCode(text, lang).join("\n") : text).split(
        "\n"
      );
      return options.expanded
        ? new Text(lines.join("\n"), 0, 0)
        : new SingleLineText(
            theme.fg("muted", compactToolResult(text, lines.length))
          );
    },
  };
}

export function createToolComponent(
  tui: TUI,
  toolName: string,
  toolCallId: string,
  args: unknown,
  expanded: boolean,
  cwd = process.cwd()
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    toolName,
    toolCallId,
    args ?? {},
    undefined,
    createToolRenderers(toolName),
    tui,
    cwd
  );
  component.setExpanded(expanded);
  component.markExecutionStarted();
  return component;
}

export function toolResultPayload(
  text: string,
  isError: boolean,
  details?: unknown
): {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError: boolean;
} {
  return { content: [{ type: "text", text }], details, isError };
}
