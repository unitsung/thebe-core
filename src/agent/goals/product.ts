import type { GoalEvent } from "./runner.ts";
import type { GoalRun, GoalRunStatus, SubagentRun } from "../types.ts";

/** Product-facing Goal status. Runtime `pausing` collapses to `running`. */
export type ProductGoalStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ProductGoalControls = {
  pause: boolean;
  resume: boolean;
  stop: boolean;
};

export type ProductRun = {
  id: string;
  goalId: string;
  sessionId: string;
  status: string;
  role?: string;
  progress?: number;
  currentStep?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProductError = {
  code: string;
  message: string;
  retryable?: boolean;
};

export type ProductGoal = {
  id: string;
  sessionId: string;
  title: string;
  status: ProductGoalStatus;
  phase: GoalRunStatus;
  progress?: number;
  currentStep?: string;
  iteration: number;
  maxIterations: number;
  criteria?: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  summary?: string;
  artifactId?: string;
  error?: ProductError;
  currentRun?: ProductRun;
  controls: ProductGoalControls;
};

export type ProductGoalEvent = {
  id: string;
  type: GoalEvent["type"];
  goalId: string;
  at: string;
  title?: string;
  iteration?: number;
  maxIterations?: number;
  progress?: number;
  status?: ProductGoalStatus;
  phase?: string;
  complete?: boolean;
  score?: number;
  critique?: string;
  remainingTasks?: string[];
  worker?: { id: string; role: string; status: string; title?: string };
  message?: string;
  summary?: string;
  totalIterations?: number;
};

const CRITIQUE_LIMIT = 400;

export function mapGoalStatus(status: GoalRunStatus | "failed"): ProductGoalStatus {
  switch (status) {
    case "running":
    case "pausing":
      return "running";
    case "paused":
      return "paused";
    case "completed":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "max_iterations":
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

export function goalControls(status: GoalRunStatus): ProductGoalControls {
  return {
    pause: status === "running",
    resume: status === "paused",
    stop: status === "running" || status === "pausing" || status === "paused",
  };
}

export function toProductGoal(run: GoalRun): ProductGoal {
  const progress =
    run.maxIterations > 0
      ? Math.min(1, Math.max(0, run.iteration / run.maxIterations))
      : undefined;
  return {
    id: run.thebeSessionId,
    sessionId: run.thebeSessionId,
    title: run.goal,
    status: mapGoalStatus(run.status),
    phase: run.status,
    progress,
    currentStep: currentStep(run),
    iteration: run.iteration,
    maxIterations: run.maxIterations,
    criteria: run.criteria?.slice(),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt ?? run.finishedAt ?? run.createdAt,
    finishedAt: run.finishedAt,
    summary: run.summary,
    artifactId: run.artifactId,
    error: run.error
      ? {
          code: run.status === "max_iterations" ? "max_iterations" : "goal_failed",
          message: run.error,
        }
      : undefined,
    currentRun: run.activeSubagent
      ? toProductRun(run.thebeSessionId, run.activeSubagent)
      : undefined,
    controls: goalControls(run.status),
  };
}

export function toProductGoalEvent(
  goalId: string,
  event: GoalEvent,
  index: number,
  at: string,
): ProductGoalEvent {
  const id = String(index);
  switch (event.type) {
    case "goal_started":
      return {
        id,
        type: event.type,
        goalId,
        at,
        title: event.goal,
        maxIterations: event.maxIterations,
      };
    case "goal_iteration":
      return {
        id,
        type: event.type,
        goalId,
        at,
        iteration: event.iteration,
        maxIterations: event.maxIterations,
        progress:
          event.maxIterations > 0
            ? Math.min(1, Math.max(0, event.iteration / event.maxIterations))
            : undefined,
      };
    case "goal_reviewed":
      return {
        id,
        type: event.type,
        goalId,
        at,
        iteration: event.iteration,
        complete: event.complete,
        score: event.score,
        critique: truncate(event.critique, CRITIQUE_LIMIT),
        remainingTasks: event.remainingTasks?.slice(),
      };
    case "goal_completed":
      return {
        id,
        type: event.type,
        goalId,
        at,
        status: mapGoalStatus(event.status),
        phase: event.status,
        summary: event.summary,
        totalIterations: event.totalIterations,
      };
    case "goal_status":
      return {
        id,
        type: event.type,
        goalId,
        at,
        status: mapGoalStatus(event.status === "pausing" ? "pausing" : event.status),
        phase: event.status,
        message: event.message,
      };
    case "goal_subagent_update":
      return {
        id,
        type: event.type,
        goalId,
        at,
        iteration: event.iteration,
        worker: {
          id: event.run.runId,
          role: event.role,
          status: event.run.status,
          title: event.run.profileName,
        },
      };
  }
}

export function isTerminalGoalStatus(
  status: GoalRunStatus,
): status is "completed" | "cancelled" | "failed" | "max_iterations" {
  return (
    status === "completed" ||
    status === "cancelled" ||
    status === "failed" ||
    status === "max_iterations"
  );
}

function toProductRun(goalId: string, run: SubagentRun): ProductRun {
  const last = run.activity?.at(-1);
  return {
    id: run.runId,
    goalId,
    sessionId: run.parentSessionId,
    status: run.status,
    role: run.profileName,
    currentStep: last?.title,
    createdAt: run.createdAt,
    updatedAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
  };
}

function currentStep(run: GoalRun): string | undefined {
  if (run.status === "pausing") return "Pausing current checkpoint";
  if (run.status === "paused") return "Paused";
  const last = run.activeSubagent?.activity?.at(-1)?.title;
  if (last) return last;
  if (run.activeSubagent) {
    return `${run.activeSubagent.profileName} ${run.activeSubagent.status}`;
  }
  if (run.summary) return run.summary;
  if (run.iteration > 0) return `Checkpoint ${run.iteration} of ${run.maxIterations}`;
  return undefined;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}
