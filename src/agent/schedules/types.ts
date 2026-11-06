export type GoalScheduleInput = {
  title: string;
  goal: string;
  criteria?: string[];
  maxIterations?: number;
  /** Model each occurrence's Goal session (and so its workers and reviewer) uses; the host default when omitted. */
  model?: { providerId: string; modelId: string };
  startAt: string;
  /** Fixed elapsed time, not a calendar-day rule. */
  intervalMinutes?: number;
  /** Five-field cron in `timeZone`; replaces `intervalMinutes` (not both). `startAt` is the earliest run. */
  cron?: string;
  /** IANA zone the cron is read in; defaults to the Core host's zone. */
  timeZone?: string;
  /**
   * What an occurrence may do. `auto` (the default) works like any Goal. `observe` runs it read-only:
   * the worker has no edit, write or shell tool, so it reports what it found and what it would do and
   * changes nothing. Use it to see whether a new schedule is worth trusting before it can act.
   */
  acceptMode?: "auto" | "observe";
  /** Let each occurrence's worker ask the person one question mid-run; without it a need becomes `blocked`. */
  allowAsk?: boolean;
  /** After an occurrence passes its independent review, wait for the person to accept before it finishes. */
  reviewBeforeDone?: boolean;
};

export type GoalSchedule = GoalScheduleInput & {
  id: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastSessionId?: string;
  lastError?: string;
  dispatching?: boolean;
};
