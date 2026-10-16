export type GoalScheduleInput = {
  title: string;
  goal: string;
  criteria?: string[];
  maxIterations?: number;
  startAt: string;
  /** Fixed elapsed time, not a calendar-day rule. */
  intervalMinutes?: number;
  /** Five-field cron in `timeZone`; replaces `intervalMinutes` (not both). `startAt` is the earliest run. */
  cron?: string;
  /** IANA zone the cron is read in; defaults to the Core host's zone. */
  timeZone?: string;
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
