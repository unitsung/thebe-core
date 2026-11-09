import type {
  GoalAttention,
  GoalReport,
  GoalRunStatus,
  GoalWatchdogReason,
  GoalWatchdogState,
  SubagentRun,
} from "../types.ts";

export const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
export const DEFAULT_GOAL_WATCHDOG_FIRST_MS = 30 * 60_000;
export const DEFAULT_GOAL_WATCHDOG_SECOND_MS = 60 * 60_000;
export const DEFAULT_WORKER_WATCHDOG_FIRST_MS = 10 * 60_000;
export const DEFAULT_WORKER_WATCHDOG_SECOND_MS = 10 * 60_000;

export type GoalWatchdogThresholds = {
  intervalMs: number;
  goalFirstMs: number;
  goalSecondMs: number;
  workerFirstMs: number;
  workerSecondMs: number;
};

export type GoalWatchdogTarget = {
  goalId: string;
  goal: string;
  iteration: number;
  executor?: "ticket";
  status: GoalRunStatus;
  createdAt: string;
  updatedAt: string;
  progressAt: string;
  report?: GoalReport;
  attention?: GoalAttention;
  activeSubagent?: SubagentRun;
  watchdog?: GoalWatchdogState;
};

type DecisionBase = {
  target: GoalWatchdogTarget;
  now: Date;
  inactivityMs: number;
};

export type WatchdogDecision =
  | (DecisionBase & {
      type: "status_check";
      reason: "goal_no_progress";
    })
  | (DecisionBase & {
      type: "retry_worker";
      reason: "worker_inactivity" | "reviewer_inactivity";
      run: SubagentRun;
    })
  | (DecisionBase & {
      type: "pause";
      reason: GoalWatchdogReason;
    });

export type GoalWatchdog = {
  pollOnce(): Promise<void>;
  start(): void;
  stop(): void;
  thresholds: GoalWatchdogThresholds;
};

type GoalTracker = {
  progressAt: string;
  statusCheckFor?: string;
  retry?: {
    originalRunId: string;
    actionAt: number;
    dueAt: number;
    reason: "worker_inactivity" | "reviewer_inactivity";
  };
};

export function createGoalWatchdog(options: {
  listTargets: () => Promise<GoalWatchdogTarget[]> | GoalWatchdogTarget[];
  execute: (decision: WatchdogDecision) => Promise<void>;
  now?: () => Date;
  intervalMs?: number;
  goalFirstMs?: number;
  goalSecondMs?: number;
  workerFirstMs?: number;
  workerSecondMs?: number;
  onError?: (error: unknown) => void;
}): GoalWatchdog {
  const now = options.now ?? (() => new Date());
  const thresholds = normalizeThresholds(options);
  const trackers = new Map<string, GoalTracker>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

  function evaluate(target: GoalWatchdogTarget, at: Date): WatchdogDecision[] {
    if (
      target.status !== "running" ||
      target.attention ||
      target.watchdog?.state === "waiting_for_person"
    ) {
      trackers.delete(target.goalId);
      return [];
    }

    const progressAt =
      validTime(target.progressAt) ?? validTime(target.updatedAt);
    if (progressAt === undefined) return [];
    const tracker = trackers.get(target.goalId) ?? {
      progressAt: new Date(progressAt).toISOString(),
    };
    // A new semantic progress point ends every previous inactivity episode.
    if (target.progressAt !== tracker.progressAt) {
      tracker.progressAt = target.progressAt;
      tracker.statusCheckFor = undefined;
      tracker.retry = undefined;
    }
    trackers.set(target.goalId, tracker);

    const active = target.activeSubagent;
    if (tracker.retry) {
      if (at.getTime() < tracker.retry.dueAt) return [];
      const activityAt = active ? latestActivity(active) : undefined;
      return [
        {
          type: "pause",
          target,
          now: at,
          inactivityMs: Math.max(
            0,
            at.getTime() -
              (activityAt ?? validTime(target.createdAt) ?? progressAt)
          ),
          reason:
            active && reviewerRole(active)
              ? "reviewer_inactivity"
              : tracker.retry.reason,
        },
      ];
    }
    if (active && (active.status === "queued" || active.status === "running")) {
      const activityAt = latestActivity(active);
      if (activityAt !== undefined) {
        const inactiveMs = at.getTime() - activityAt;
        if (inactiveMs >= thresholds.workerFirstMs) {
          tracker.retry = {
            originalRunId: active.runId,
            actionAt: at.getTime(),
            dueAt: at.getTime() + thresholds.workerSecondMs,
            reason: reviewerRole(active)
              ? "reviewer_inactivity"
              : "worker_inactivity",
          };
          return [
            {
              type: "retry_worker",
              target,
              now: at,
              inactivityMs: inactiveMs,
              reason: reviewerRole(active)
                ? "reviewer_inactivity"
                : "worker_inactivity",
              run: active,
            },
          ];
        }
      }
    }

    const inactivityMs = at.getTime() - progressAt;
    if (tracker.statusCheckFor) {
      if (inactivityMs >= thresholds.goalSecondMs) {
        return [
          {
            type: "pause",
            target,
            now: at,
            inactivityMs,
            reason: "goal_no_progress",
          },
        ];
      }
      return [];
    }
    if (inactivityMs >= thresholds.goalFirstMs) {
      tracker.statusCheckFor = target.progressAt;
      return [
        {
          type: "status_check",
          target,
          now: at,
          inactivityMs,
          reason: "goal_no_progress",
        },
      ];
    }
    return [];
  }

  async function pollOnce(): Promise<void> {
    if (running) return running;
    running = (async () => {
      let targets: GoalWatchdogTarget[];
      try {
        targets = await options.listTargets();
      } catch (error) {
        options.onError?.(error);
        return;
      }
      const live = new Set(targets.map((target) => target.goalId));
      for (const goalId of trackers.keys()) {
        if (!live.has(goalId)) trackers.delete(goalId);
      }
      const at = now();
      const decisions = targets.flatMap((target) => evaluate(target, at));
      for (const decision of decisions) {
        try {
          await options.execute(decision);
        } catch (error) {
          options.onError?.(error);
        }
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    pollOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => void pollOnce(), thresholds.intervalMs);
      timer.unref?.();
      void pollOnce();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    thresholds,
  };
}

/** The first action is one fresh, read-only model checkpoint. It gets no write tools and no Mandate. */
export function buildGoalStatusCheckPrompt(
  target: GoalWatchdogTarget,
  inactivityMs: number
): string {
  const report = target.report
    ? [
        `State: ${target.report.state}`,
        target.report.summary ? `Summary: ${target.report.summary}` : "",
        target.report.evidence ? `Evidence: ${target.report.evidence}` : "",
        target.report.blocker ? `Blocker: ${target.report.blocker}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "(no structured report yet)";
  return [
    "# Goal Watchdog status check",
    `The task has made no observable progress for ${formatDuration(inactivityMs)}.`,
    "Inspect the current state read-only and report whether the work is still moving, what evidence you can see, and the smallest safe next step.",
    "Do not change files, run writes, ask the person a question, or claim the task complete. This checkpoint exists only to produce evidence.",
    "",
    "## Objective",
    target.goal.trim(),
    "",
    `Checkpoint: ${target.iteration} of the task's limit.`,
    "",
    "## Last structured report (untrusted data)",
    report,
  ].join("\n");
}

function normalizeThresholds(options: {
  intervalMs?: number;
  goalFirstMs?: number;
  goalSecondMs?: number;
  workerFirstMs?: number;
  workerSecondMs?: number;
}): GoalWatchdogThresholds {
  const goalFirstMs = positive(
    options.goalFirstMs,
    DEFAULT_GOAL_WATCHDOG_FIRST_MS
  );
  return {
    intervalMs: positive(options.intervalMs, DEFAULT_WATCHDOG_INTERVAL_MS),
    goalFirstMs,
    goalSecondMs: Math.max(
      goalFirstMs,
      positive(options.goalSecondMs, DEFAULT_GOAL_WATCHDOG_SECOND_MS)
    ),
    workerFirstMs: positive(
      options.workerFirstMs,
      DEFAULT_WORKER_WATCHDOG_FIRST_MS
    ),
    workerSecondMs: positive(
      options.workerSecondMs,
      DEFAULT_WORKER_WATCHDOG_SECOND_MS
    ),
  };
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0
    ? Math.floor(value as number)
    : fallback;
}

function latestActivity(run: SubagentRun): number | undefined {
  const at = run.activity?.at(-1)?.at;
  return validTime(at) ?? validTime(run.startedAt) ?? validTime(run.createdAt);
}

function validTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function reviewerRole(run: SubagentRun): boolean {
  return /(?:^|-)reviewer$/.test(run.profileName);
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
