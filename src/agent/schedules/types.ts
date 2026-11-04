import type { AcceptMode } from "../policy/types.ts";

/**
 * What a schedule does at its due time: `off` nothing at all, `observe` only a record that it would
 * have run, `auto` start the Goal. A new schedule starts in `observe`; a stored one with no mode is `auto`.
 */
export type ScheduleMode = AcceptMode;

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
  /** Defaults to `observe` on create; left out on edit it keeps the schedule's current mode. */
  mode?: ScheduleMode;
};

export type GoalSchedule = GoalScheduleInput & {
  id: string;
  mode: ScheduleMode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastSessionId?: string;
  lastError?: string;
  dispatching?: boolean;
};

/** What an observed schedule would have run: the Goal and the limits the occurrence would have had. */
export type ScheduleObservationScope = {
  criteria: string[];
  maxIterations?: number;
  model?: { providerId: string; modelId: string };
};

/** The record an observed schedule leaves at its due time instead of running. */
export type ScheduleObservation = {
  /** `<scheduleId>:<dueAt>`, so one occurrence is recorded once however often it is processed. */
  id: string;
  scheduleId: string;
  title: string;
  goal: string;
  /** The time the occurrence was due. */
  dueAt: string;
  /** When Core recorded it. */
  observedAt: string;
  scope: ScheduleObservationScope;
};

/** A record as Activity reads it: the schedule's mode now is joined on every read, never stored. */
export type ScheduleObservationView = ScheduleObservation & {
  scheduleMode: ScheduleMode;
};
