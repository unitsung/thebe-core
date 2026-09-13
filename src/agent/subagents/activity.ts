import type { NormalizedEvent } from "../runtime/index.ts";
import type {
  SubagentActivity,
  SubagentActivityDetailKind,
  SubagentRun,
} from "../types.ts";

const MAX_RETAINED_ACTIVITY = 160;
const MAX_ACTIVITY_DETAIL_CHARS = 4_000;
const MAX_RESPONSE_CHARS = 64_000;

export type ActivityRun = SubagentRun & {
  nextActivityId: number;
};

export function appendActivity(
  run: ActivityRun,
  activity: Omit<SubagentActivity, "id" | "at">,
  now: () => Date,
  merge = false,
): void {
  const entries = run.activity ?? (run.activity = []);
  const previous = entries.at(-1);
  if (
    merge &&
    previous?.kind === activity.kind &&
    previous.title === activity.title
  ) {
    if (activity.detail !== undefined) {
      previous.detail = boundedText(
        `${previous.detail ?? ""}${activity.detail}`,
        MAX_ACTIVITY_DETAIL_CHARS,
      );
    }
    previous.at = now().toISOString();
    return;
  }

  const entry: SubagentActivity = {
    id: run.nextActivityId++,
    at: now().toISOString(),
    ...activity,
    ...(activity.detail
      ? { detail: boundedText(activity.detail, MAX_ACTIVITY_DETAIL_CHARS) }
      : {}),
  };
  if (entry.detail !== undefined) {
    setToolDetail(entry, entry.detailKind, entry.detail);
  }
  entries.push(entry);
  if (entries.length > MAX_RETAINED_ACTIVITY) {
    entries.splice(0, entries.length - MAX_RETAINED_ACTIVITY);
  }
}

export function recordEvent(
  run: ActivityRun,
  event: NormalizedEvent,
  now: () => Date,
): void {
  switch (event.type) {
    case "text_delta":
      run.responseText = boundedText(
        `${run.responseText ?? ""}${event.text}`,
        MAX_RESPONSE_CHARS,
      );
      appendActivity(run, { kind: "response", title: "responding" }, now, true);
      break;
    case "thinking_delta":
      appendActivity(
        run,
        { kind: "thinking", title: "thinking", detail: event.text },
        now,
        true,
      );
      break;
    case "tool_start":
      upsertToolActivity(
        run,
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          phase: "started",
          detailKind: "input",
          detail: event.args === undefined ? undefined : safeJson(event.args),
        },
        now,
      );
      break;
    case "tool_update":
      upsertToolActivity(
        run,
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          phase: "running",
          detailKind: "progress",
          detail:
            event.text ||
            (event.args === undefined ? undefined : safeJson(event.args)),
        },
        now,
      );
      break;
    case "tool_end":
      upsertToolActivity(
        run,
        {
          kind: event.isError ? "error" : "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          phase: event.isError ? "failed" : "completed",
          detailKind: "output",
          detail: event.text,
        },
        now,
      );
      break;
    case "tool_watchdog_timeout":
      upsertToolActivity(
        run,
        {
          kind: "error",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          phase: "failed",
          detailKind: "output",
          detail: `tool watchdog timeout after ${event.elapsedMs}ms`,
        },
        now,
      );
      break;
    case "permission_requested":
      appendActivity(
        run,
        {
          kind: "approval",
          title: `${event.toolName} awaiting approval`,
          detail: event.argsSummary,
        },
        now,
      );
      break;
    case "turn_end":
      appendActivity(
        run,
        { kind: "status", title: `turn ${run.turns}/${run.maxTurns} complete` },
        now,
      );
      break;
    case "compaction_start":
      appendActivity(run, { kind: "status", title: "compacting context" }, now);
      break;
    case "compaction_end":
      appendActivity(
        run,
        {
          kind: event.errorMessage ? "error" : "status",
          title: event.errorMessage
            ? "compaction failed"
            : "compaction complete",
          detail: event.errorMessage,
        },
        now,
      );
      break;
    case "error":
      appendActivity(
        run,
        { kind: "error", title: "runtime error", detail: event.message },
        now,
      );
      break;
    case "interrupted":
      appendActivity(run, { kind: "status", title: "interrupted" }, now);
      break;
    default:
      break;
  }
}

function upsertToolActivity(
  run: ActivityRun,
  update: {
    kind?: "tool" | "error";
    toolCallId: string;
    toolName: string;
    phase: NonNullable<SubagentActivity["phase"]>;
    detailKind: NonNullable<SubagentActivity["detailKind"]>;
    detail?: string;
  },
  now: () => Date,
): void {
  const entries = run.activity ?? (run.activity = []);
  const existing = [...entries]
    .reverse()
    .find((entry) => entry.toolCallId === update.toolCallId);
  if (!existing) {
    appendActivity(
      run,
      {
        kind: update.kind ?? "tool",
        title: update.toolName,
        toolCallId: update.toolCallId,
        toolName: update.toolName,
        phase: update.phase,
        detailKind: update.detailKind,
        detail: update.detail,
      },
      now,
    );
    return;
  }

  migrateLegacyToolDetail(existing);
  const appendProgress =
    existing.phase === "running" &&
    existing.detailKind === "progress" &&
    update.phase === "running";
  existing.kind = update.kind ?? existing.kind;
  existing.title = update.toolName;
  existing.toolName = update.toolName;
  existing.phase = update.phase;
  existing.detailKind = update.detailKind;
  if (update.detail !== undefined) {
    const nextDetail = appendProgress
      ? `${existing.progress ?? ""}${update.detail}`
      : update.detail;
    const bounded = boundedText(nextDetail, MAX_ACTIVITY_DETAIL_CHARS);
    setToolDetail(existing, update.detailKind, bounded);
    existing.detail = bounded;
  }
  existing.at = now().toISOString();
}

export function migrateLegacyToolDetail(entry: SubagentActivity): void {
  if (entry.detail === undefined || entry.detailKind === undefined) return;
  const current =
    entry.detailKind === "input"
      ? entry.input
      : entry.detailKind === "progress"
        ? entry.progress
        : entry.output;
  if (current === undefined) setToolDetail(entry, entry.detailKind, entry.detail);
}

function setToolDetail(
  entry: SubagentActivity,
  kind: SubagentActivityDetailKind | undefined,
  value: string,
): void {
  if (kind === "input") entry.input = value;
  else if (kind === "progress") entry.progress = value;
  else if (kind === "output") entry.output = value;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}
