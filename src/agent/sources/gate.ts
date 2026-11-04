import {
  severityRank,
  threadKey,
  type GateOutcome,
  type GateSettings,
  type QuietHours,
  type Trigger,
  type TriggerRecord,
} from "./types.ts";

const DEFAULT_QUIET_HOURS: QuietHours = { start: "23:00", end: "08:00" };
const DEFAULT_DEDUP_WINDOW_MS = 30 * 60_000;
const MAX_DEDUP_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Reads a source's entry in the policy. Only `enabled` is required; anything missing or malformed
 * falls back to the default, so a bad value can never make the Gate open wider than the default.
 */
export function parseGateSettings(raw: unknown): GateSettings {
  const value = isRecord(raw) ? raw : {};
  const minSeverity =
    value.minSeverity === "info" ||
    value.minSeverity === "warning" ||
    value.minSeverity === "critical"
      ? value.minSeverity
      : "warning";
  const window = value.dedupWindowMinutes;
  return {
    enabled: value.enabled === true,
    kinds: Array.isArray(value.kinds)
      ? value.kinds.filter((kind): kind is string => typeof kind === "string")
      : [],
    minSeverity,
    quietHours:
      value.quietHours === null
        ? undefined
        : (parseQuietHours(value.quietHours) ?? DEFAULT_QUIET_HOURS),
    dedupWindowMs:
      typeof window === "number" && Number.isFinite(window) && window >= 0
        ? Math.min(window * 60_000, MAX_DEDUP_WINDOW_MS)
        : DEFAULT_DEDUP_WINDOW_MS,
  };
}

/**
 * The deterministic gate in front of any model call. It checks, in order: the source is enabled, the
 * kind is wanted, the severity reaches the minimum, it is not quiet hours (critical events break
 * through), and the same kind on the same Thread has not already passed inside the window.
 * `recent` is the earlier records; only ones that passed count towards de-duplication.
 */
export function gate(
  trigger: Trigger,
  settings: GateSettings,
  now: Date,
  recent: readonly TriggerRecord[]
): GateOutcome {
  if (!settings.enabled) return { result: "filtered", reason: "disabled" };
  if (settings.kinds.length > 0 && !settings.kinds.includes(trigger.kind)) {
    return { result: "filtered", reason: "kind" };
  }
  if (severityRank(trigger.severity) < severityRank(settings.minSeverity)) {
    return { result: "filtered", reason: "severity" };
  }
  if (
    settings.quietHours &&
    trigger.severity !== "critical" &&
    isQuiet(now, settings.quietHours)
  ) {
    return { result: "filtered", reason: "quiet_hours" };
  }
  const key = threadKey(trigger.thread);
  const earlier = recent.find(
    (record) =>
      record.outcome.result === "passed" &&
      record.trigger.id !== trigger.id &&
      record.trigger.source === trigger.source &&
      threadKey(record.trigger.thread) === key &&
      record.trigger.kind === trigger.kind &&
      now.getTime() - Date.parse(record.decidedAt) < settings.dedupWindowMs
  );
  if (earlier) {
    return {
      result: "duplicate",
      reason: "duplicate",
      duplicateOf: earlier.trigger.id,
    };
  }
  return { result: "passed" };
}

/** True when the local time of `now` is inside the window; a window may wrap past midnight. */
export function isQuiet(now: Date, hours: QuietHours): boolean {
  const start = minutes(hours.start);
  const end = minutes(hours.end);
  if (start === undefined || end === undefined || start === end) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  return start < end ? at >= start && at < end : at >= start || at < end;
}

function parseQuietHours(value: unknown): QuietHours | undefined {
  if (!isRecord(value)) return undefined;
  const { start, end } = value;
  if (typeof start !== "string" || typeof end !== "string") return undefined;
  if (minutes(start) === undefined || minutes(end) === undefined) {
    return undefined;
  }
  return { start, end };
}

function minutes(clock: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
