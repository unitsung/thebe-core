import type { GoalSchedule } from "./types.ts";

/**
 * Schedules as `GET /v1/schedules` returns them, exported as data for the App's decoders. `mode` is
 * additive: `legacy` holds the same rows as a Core that predates accept modes sends them (no `mode`),
 * which the App reads as auto, the way Core does.
 */
export const SCHEDULES_CONTRACT_PATH = "contracts/schedules.json";

const row = (overrides: Partial<GoalSchedule>): GoalSchedule => ({
  id: "sched-1",
  title: "Nightly health check",
  goal: "Check that every container is healthy",
  criteria: ["Every container is running"],
  maxIterations: 3,
  startAt: "2026-11-04T09:00:00.000Z",
  cron: "0 9 * * *",
  timeZone: "Asia/Shanghai",
  mode: "observe",
  enabled: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-04T09:00:03.000Z",
  nextRunAt: "2026-11-05T01:00:00.000Z",
  ...overrides,
});

export function buildSchedulesContract() {
  const schedules = [
    row({}),
    row({
      id: "sched-2",
      title: "Weekly library tidy",
      cron: undefined,
      timeZone: undefined,
      intervalMinutes: 10080,
      criteria: undefined,
      mode: "auto",
      lastRunAt: "2026-11-04T08:00:02.000Z",
      lastSessionId: "goal-1",
    }),
    row({ id: "sched-3", title: "Paused idea", mode: "off", enabled: false }),
  ];
  return {
    version: 1,
    /** What Core sends now: every row carries its mode. */
    schedules,
    /** The same rows from a Core that predates modes. They ran their Goals, so the App reads them as auto. */
    legacy: schedules.map(({ mode: _mode, ...rest }) => rest),
  };
}
