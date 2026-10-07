export type GoalScheduleInput = {
  title: string;
  goal: string;
  criteria?: string[];
  maxIterations?: number;
  startAt: string;
  /** Fixed elapsed time, not a calendar-day rule. */
  intervalMinutes?: number;
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
