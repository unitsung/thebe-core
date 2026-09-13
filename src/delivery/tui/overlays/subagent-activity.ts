import { truncateToWidth, wrapTextWithAnsi } from "../rendering/adapter.ts";
import type { SubagentActivity, SubagentActivityDetailKind, SubagentRun } from "../../../agent/index.ts";
import { chalk } from "../theme.ts";
import { activityGlyph, activityKindGlyph, activityPhase, activitySummary, progressBar, progressPercent } from "../display/activity.ts";

export function renderActivity(entry: SubagentActivity, width: number, thinkingExpanded: boolean, toolsExpanded: boolean): string[] {
  const icon = activityKindGlyph(entry.kind);
  const inferredPhase = activityPhase(entry);
  const isTool = Boolean(entry.toolName) || entry.kind === "tool" || /\s+(started|running|completed|failed)$/.test(entry.title);
  const title = isTool
    ? `${icon} ${entry.toolName ?? entry.title.replace(/\s+(started|running|completed|failed)$/, "")} · ${entry.phase ?? inferredPhase} · Ctrl+O`
    : entry.kind === "thinking" ? `${icon} Thinking · Ctrl+T` : `${icon} ${entry.title}`;
  const style = entry.kind === "error" ? chalk.red
    : entry.kind === "approval" ? chalk.yellow
      : entry.kind === "tool" ? chalk.cyan
        : entry.kind === "response" ? chalk.green : chalk.dim;
  const lines = wrapTextWithAnsi(chalk.bold(style(title)), width);
  const showDetail = hasActivityDetail(entry) && entry.kind !== "response" &&
    (entry.kind === "thinking" ? thinkingExpanded : isTool ? toolsExpanded : true);
  if (showDetail) lines.push(...(isTool
    ? formatToolDetailLines(entry, width, entry.phase ?? inferredPhase)
    : formatDetailLines(entry, width, entry.phase ?? inferredPhase)));
  return lines;
}

function hasActivityDetail(entry: SubagentActivity): boolean {
  return entry.detail !== undefined || entry.input !== undefined || entry.progress !== undefined || entry.output !== undefined;
}

function formatToolDetailLines(entry: SubagentActivity, width: number, phase: SubagentActivity["phase"]): string[] {
  const details = [
    ["Input:", toolDetail(entry, "input", phase) === undefined ? undefined : formatToolInput(toolDetail(entry, "input", phase)!)],
    ["Progress:", toolDetail(entry, "progress", phase)],
    ["Output:", toolDetail(entry, "output", phase)],
  ] as const;
  return details.flatMap(([label, value]) => value === undefined || value === "" ? [] : formatDetailValue(label, value, width));
}

function toolDetail(entry: SubagentActivity, kind: "input" | "progress" | "output", phase: SubagentActivity["phase"]): string | undefined {
  const current = entry[kind];
  if (current !== undefined) return current;
  if (entry.detailKind === kind) return entry.detail;
  if (entry.detailKind !== undefined) return undefined;
  if (kind === "input" && phase === "started") return entry.detail;
  if (kind === "progress" && phase === "running") return entry.detail;
  if (kind === "output" && (phase === "completed" || phase === "failed")) return entry.detail;
  return undefined;
}

function formatDetailLines(entry: SubagentActivity, width: number, phase: SubagentActivity["phase"]): string[] {
  const source = entry.detailKind === "input" || phase === "started" ? formatToolInput(entry.detail ?? "") : (entry.detail ?? "");
  return formatDetailValue(detailLabel(entry.detailKind, phase), source, width);
}

function formatDetailValue(label: string, source: string, width: number): string[] {
  const maxChars = 2_000;
  const clipped = source.length > maxChars ? `${source.slice(0, maxChars)}…` : source;
  const rendered: string[] = [];
  for (const [index, line] of clipped.replace(/\r/g, "").split("\n").entries()) {
    rendered.push(...wrapTextWithAnsi(chalk.dim(`  ${index === 0 ? `${label} ` : "    "}${line}`), width));
  }
  const truncated = source.length > maxChars || rendered.length > 4;
  return [...rendered.slice(0, 4), ...(truncated ? [chalk.dim("  … output truncated; open the child result for the full response")] : [])];
}

function formatToolInput(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>).map(([key, item]) => `${key}=${singleLine(stringValue(item), 360)}`).join(" · ");
    }
  } catch {
    // Keep non-JSON runtime input readable as-is.
  }
  return singleLine(value, 720);
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }

function detailLabel(kind: SubagentActivityDetailKind | undefined, phase: SubagentActivity["phase"]): string {
  if (kind === undefined && phase === undefined) return "Detail:";
  if (kind === "input" || phase === "started") return "Input:";
  if (kind === "progress" || phase === "running") return "Progress:";
  return "Output:";
}

export function latestActivity(run: SubagentRun): string {
  const entry = run.activity?.at(-1);
  return entry ? activitySummary(entry) : run.status;
}

export function statusIcon(status: SubagentRun["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  if (status === "cancelled") return "—";
  if (status === "queued") return "○";
  return "●";
}

export function resultWaitingGlyph(status: SubagentRun["status"]): string {
  if (status === "queued") return activityGlyph.queued;
  if (status === "failed") return activityGlyph.error;
  if (status === "cancelled") return activityGlyph.cancelled;
  return activityGlyph.running;
}

export function currentPhase(run: SubagentRun): string {
  const entry = run.activity?.at(-1);
  return entry ? activityPhase(entry) : run.status;
}

export function progressLabel(run: SubagentRun): string {
  const percent = progressPercent(run.turns, run.maxTurns);
  return `${run.turns}/${run.maxTurns} turns · ${percent}% ${progressBar(run.turns, run.maxTurns, 12)}`;
}

export function singleLine(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}
