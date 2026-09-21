import type {
  SubagentActivity,
  SubagentActivityKind,
  SubagentRunStatus,
} from "../../../agent/index.ts";

/** Shared visual language for ordinary turns, Goals, and subagents. */
export const activityGlyph = {
  goal: "◆",
  promptCollapsed: "▸",
  promptExpanded: "▾",
  thinking: "◇",
  tool: "⚙",
  result: "✓",
  error: "✗",
  approval: "!",
  running: "●",
  queued: "○",
  cancelled: "—",
  status: "·",
} as const;

export function subagentStatusGlyph(status: SubagentRunStatus): string {
  if (status === "completed") return activityGlyph.result;
  if (status === "failed" || status === "interrupted") return activityGlyph.error;
  if (status === "cancelled") return activityGlyph.cancelled;
  if (status === "queued") return activityGlyph.queued;
  return activityGlyph.running;
}

export function activityKindGlyph(kind: SubagentActivityKind): string {
  if (kind === "thinking") return activityGlyph.thinking;
  if (kind === "tool") return activityGlyph.tool;
  if (kind === "approval") return activityGlyph.approval;
  if (kind === "response") return activityGlyph.result;
  if (kind === "error") return activityGlyph.error;
  return activityGlyph.status;
}

export function activityPhase(
  entry: Pick<SubagentActivity, "phase" | "title">,
): NonNullable<SubagentActivity["phase"]> {
  if (entry.phase) return entry.phase;
  const phase = entry.title.match(/\s+(started|running|completed|failed)$/)?.[1];
  return phase === "started" || phase === "running" || phase === "completed" || phase === "failed"
    ? phase
    : "running";
}

export function activitySummary(entry: SubagentActivity): string {
  const phase = activityPhase(entry);
  const isTool = Boolean(entry.toolName) || entry.kind === "tool" ||
    /\s+(started|running|completed|failed)$/.test(entry.title);
  return isTool
    ? `Tool · ${entry.toolName ?? entry.title.replace(/\s+(started|running|completed|failed)$/, "")} · ${phase}`
    : entry.title;
}

export function progressPercent(current: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}

export function progressBar(current: number, total: number, width = 10): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const filled = Math.round((progressPercent(current, total) / 100) * safeWidth);
  return `${"█".repeat(filled)}${"░".repeat(safeWidth - filled)}`;
}
