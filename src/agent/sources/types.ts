/**
 * Vocabulary of the source runtime (see CONTEXT.md). A Source is a durable event stream that holds its
 * read position; a Trigger is one immutable event with a stable id; a Thread is the ordered Triggers of
 * one resource; the Gate is the deterministic first layer of Eval.
 */
export const SEVERITIES = ["info", "warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** The resource a Trigger is about. Its key names the Thread. */
export type ThreadRef = { kind: string; id: string; name?: string };

export function threadKey(thread: ThreadRef): string {
  return `${thread.kind}:${thread.id}`;
}

export type Trigger = {
  /** Stable: derived from the source, the resource and the source's own sequence, so a replay repeats it. */
  id: string;
  source: string;
  kind: string;
  severity: Severity;
  thread: ThreadRef;
  summary: string;
  observedAt: string;
};

export const GATE_REASONS = [
  "disabled",
  "kind",
  "severity",
  "quiet_hours",
  "duplicate",
] as const;
export type GateReason = (typeof GATE_REASONS)[number];

/** What the Gate decided. `passed` means the Trigger may be evaluated; the rest end here, with the reason. */
export type GateOutcome = {
  result: "passed" | "filtered" | "duplicate";
  reason?: GateReason;
  /** The earlier Trigger a duplicate repeats. */
  duplicateOf?: string;
};

/** A Trigger with the one Gate outcome recorded for it. Written once, never changed. */
export type TriggerRecord = {
  trigger: Trigger;
  outcome: GateOutcome;
  decidedAt: string;
};

export type QuietHours = { start: string; end: string };

/** The settings the Gate reads, parsed from the source's entry in the policy. */
export type GateSettings = {
  enabled: boolean;
  /** Empty means every kind of the source. */
  kinds: string[];
  minSeverity: Severity;
  /** Absent: no quiet hours. Critical events break through them. */
  quietHours?: QuietHours;
  /** Another Trigger of the same kind on the same Thread inside this window is a duplicate. */
  dedupWindowMs: number;
};

/** How a source is doing, as shown in the health response. */
export type SourceHealth = {
  enabled: boolean;
  lastReadAt?: string;
  consecutiveFailures: number;
  /** When the current run of read failures began. */
  failingSince?: string;
  /** True once the failures have lasted ten minutes. */
  failing: boolean;
  lastError?: string;
};
