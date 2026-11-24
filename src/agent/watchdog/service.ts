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

/**
 * Which inactivity thresholds a Goal follows. A personal coding Goal is the only class that uses the
 * configured Goal values; a Goal that runs a Ticket takes the class derived from that Ticket.
 */
export type WatchdogClass =
  | "personal"
  | "container"
  | "download"
  | "pipeline"
  | "scan"
  | "ticket";

/** The stored Ticket fields the Watchdog needs to choose a class. */
export type TicketWatchdogContext = {
  origins?: ReadonlyArray<{ source: string; kind?: string }>;
  subscriptions?: readonly string[];
};

type ClassThresholds = {
  firstMs: number;
  secondMs: number;
};

const TICKET_WATCHDOG_THRESHOLDS: Readonly<
  Record<Exclude<WatchdogClass, "personal">, ClassThresholds>
> = {
  container: { firstMs: 15 * 60_000, secondMs: 30 * 60_000 },
  download: { firstMs: 2 * 60 * 60_000, secondMs: 4 * 60 * 60_000 },
  pipeline: { firstMs: 30 * 60_000, secondMs: 60 * 60_000 },
  scan: { firstMs: 2 * 60 * 60_000, secondMs: 4 * 60 * 60_000 },
  ticket: { firstMs: 15 * 60_000, secondMs: 30 * 60_000 },
};

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
  /** Internal: set for a Ticket Goal from its stored Ticket; never part of the public Goal shape. */
  watchdogClass?: WatchdogClass;
  /** Internal: a fallback for a caller that has the stored Ticket but has not classified it yet. */
  ticket?: TicketWatchdogContext;
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

    const goalThresholds = thresholdsFor(target, thresholds);
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
      // The retry produced a different, demonstrably active worker: give the replacement its own
      // inactivity window instead of pausing it before it can make progress.
      if (
        active &&
        active.runId !== tracker.retry.originalRunId &&
        activityAt !== undefined &&
        activityAt >= tracker.retry.actionAt
      ) {
        tracker.retry = {
          originalRunId: active.runId,
          actionAt: activityAt,
          dueAt: activityAt + thresholds.workerSecondMs,
          reason: reviewerRole(active)
            ? "reviewer_inactivity"
            : "worker_inactivity",
        };
        return [];
      }
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
      if (inactivityMs >= goalThresholds.secondMs) {
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
    if (inactivityMs >= goalThresholds.firstMs) {
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

function thresholdsFor(
  target: GoalWatchdogTarget,
  defaults: GoalWatchdogThresholds
): ClassThresholds {
  const goalClass =
    target.watchdogClass ??
    (target.ticket
      ? ticketWatchdogClass(target.ticket)
      : target.executor === "ticket"
        ? "ticket"
        : "personal");
  if (goalClass === "personal") {
    return {
      firstMs: defaults.goalFirstMs,
      secondMs: defaults.goalSecondMs,
    };
  }
  return TICKET_WATCHDOG_THRESHOLDS[goalClass];
}

/**
 * A Ticket's class comes from the events that caused it and the resource it follows, never from the
 * free-form Goal text a worker sees. Explicit Trigger kinds win, then a pipeline/scan Source or
 * Thread, then any broader container/download evidence.
 */
export function ticketWatchdogClass(
  ticket: TicketWatchdogContext
): WatchdogClass {
  const origins = ticket.origins ?? [];
  const sources = origins.map((origin) => origin.source);
  const resourceKinds = (ticket.subscriptions ?? [])
    .map((thread) => /^resource:([^:]+)/.exec(thread)?.[1])
    .filter((kind): kind is string => Boolean(kind));

  // An explicit Trigger kind is the most specific evidence.
  for (const origin of origins) {
    const fromKind = classFromSignal(origin.kind);
    if (fromKind) return fromKind;
  }
  // A pipeline or scan may carry a broader download/container Source, so its own Source or
  // resource Thread is checked before the remaining Source evidence.
  for (const signal of [...sources, ...resourceKinds]) {
    const specific = classFromSignal(signal);
    if (specific === "pipeline" || specific === "scan") return specific;
  }
  for (const source of sources) {
    const fromSource = classFromSignal(source);
    if (fromSource) return fromSource;
  }
  for (const resourceKind of resourceKinds) {
    const fromThread = classFromSignal(resourceKind);
    if (fromThread) return fromThread;
  }
  return "ticket";
}

function classFromSignal(value: string | undefined): WatchdogClass | undefined {
  if (!value) return undefined;
  const signal = value.toLowerCase();
  if (
    signal.includes("pipeline") ||
    signal.includes("post-download") ||
    signal.includes("post_download")
  ) {
    return "pipeline";
  }
  if (signal.includes("scan") || signal.includes("library")) return "scan";
  if (signal.includes("container")) return "container";
  if (signal.includes("download")) return "download";
  return undefined;
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
