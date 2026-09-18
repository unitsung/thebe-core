import type { GoalEvent } from "../goals/runner.ts";
import {
  executeGoal,
  type GoalSubagentApi,
  type ManagedGoal,
} from "./execution.ts";
import type {
  GoalRun,
  GoalRunStatus,
  SubagentUpdate,
} from "../types.ts";
import type { AgentContext } from "../internal/context.ts";

export function createGoalApi(
  ctx: AgentContext,
  subagents: GoalSubagentApi,
) {
  const runs = new Map<string, ManagedGoal>();

  const snapshot = (run: ManagedGoal): GoalRun => ({
    thebeSessionId: run.thebeSessionId,
    goal: run.goal,
    criteria: run.criteria?.slice(),
    maxIterations: run.maxIterations,
    iteration: run.iteration,
    status: run.status,
    createdAt: run.createdAt,
    subagentRunIds: run.subagentRunIds.slice(),
    activeSubagent: run.activeSubagent
      ? { ...run.activeSubagent }
      : undefined,
    lastReview: run.lastReview
      ? {
          ...run.lastReview,
          remainingTasks: run.lastReview.remainingTasks?.slice(),
        }
      : undefined,
    finishedAt: run.finishedAt,
    summary: run.summary,
    finalReport: run.finalReport,
    error: run.error,
  });

  const MAX_GOAL_EVENTS = 50;

  function broadcast(run: ManagedGoal, event: GoalEvent): void {
    run.events.push({ event, at: ctx.now().toISOString() });
    if (run.events.length > MAX_GOAL_EVENTS) {
      run.events.splice(0, run.events.length - MAX_GOAL_EVENTS);
    }
    for (const listener of run.listeners) listener(event);
  }

  async function setTerminal(
    run: ManagedGoal,
    status: Exclude<GoalRunStatus, "running" | "pausing">,
    summary?: string,
    error?: string,
  ): Promise<GoalRun> {
    run.status = status;
    run.summary = summary;
    run.error = error;
    run.finishedAt = ctx.now().toISOString();
    const result = snapshot(run);
    broadcast(run, {
      type: "goal_completed",
      // GoalEvent's generic loop has no paused terminal state; the UI has the
      // authoritative GoalRun snapshot and renders paused separately.
      status: status === "paused" ? "cancelled" : status,
      totalIterations: run.iteration,
      summary: summary ?? `Goal ${status}.`,
    });
    await persistGoal(result, run.thebeSessionId);
    run.resolveFinished(result);
    return result;
  }

  function onGoalEvent(run: ManagedGoal, event: GoalEvent): void {
    if (event.type === "goal_iteration") {
      run.iteration = event.iteration;
    } else if (event.type === "goal_reviewed") {
      run.lastReviewResult = {
        complete: event.complete,
        score: event.score,
        critique: event.critique,
        remainingTasks: event.remainingTasks?.slice(),
      };
      run.lastReview = {
        score: event.score,
        critique: event.critique,
        remainingTasks: event.remainingTasks?.slice(),
      };
    }
    broadcast(run, event);
  }

  function resetFinished(run: ManagedGoal): void {
    run.finished = new Promise<GoalRun>((resolve) => {
      run.resolveFinished = resolve;
    });
  }

  async function persistGoal(
    run: GoalRun | undefined,
    thebeSessionId: string,
  ): Promise<void> {
    try {
      const meta = await ctx.lookup(thebeSessionId);
      await ctx.persist(ctx.touchMeta({ ...meta, goalRun: run }));
    } catch {
      // A persistence failure must not turn a completed Goal into a failure.
    }
  }

  function restoreGoal(persisted: GoalRun | undefined): void {
    if (!persisted || runs.has(persisted.thebeSessionId)) return;
    const interrupted =
      persisted.status === "running" || persisted.status === "pausing";
    const run = createRun({
      thebeSessionId: persisted.thebeSessionId,
      goal: persisted.goal,
      criteria: persisted.criteria,
      maxIterations: persisted.maxIterations,
    });
    run.iteration = persisted.iteration;
    run.status = interrupted ? "paused" : persisted.status;
    run.createdAt = persisted.createdAt;
    run.subagentRunIds = persisted.subagentRunIds.slice();
    run.activeSubagent = persisted.activeSubagent
      ? { ...persisted.activeSubagent }
      : undefined;
    run.lastReview = persisted.lastReview
      ? {
          ...persisted.lastReview,
          remainingTasks: persisted.lastReview.remainingTasks?.slice(),
        }
      : undefined;
    run.lastReviewResult = persisted.lastReview
      ? {
          complete: run.status === "completed",
          score: persisted.lastReview.score,
          critique: persisted.lastReview.critique,
          remainingTasks: persisted.lastReview.remainingTasks?.slice(),
        }
      : undefined;
    run.finishedAt = persisted.finishedAt;
    run.summary = interrupted
      ? `Goal paused after ${run.iteration} checkpoint(s); resume it to continue.`
      : persisted.summary;
    run.finalReport = persisted.finalReport;
    run.error = interrupted
      ? "The previous Goal process ended before its active checkpoint completed."
      : persisted.error;
    runs.set(run.thebeSessionId, run);
    if (run.status !== "running" && run.status !== "pausing") {
      run.resolveFinished(snapshot(run));
    }
  }

  function emitChild(
    run: ManagedGoal,
    iteration: number,
    role: "worker" | "reviewer",
    update: SubagentUpdate,
  ): void {
    run.activeSubagent = update.run;
    broadcast(run, {
      type: "goal_subagent_update",
      iteration,
      role,
      run: update.run,
      event: update.event,
    });
  }

  function runManagedGoal(
    run: ManagedGoal,
    initialIteration = 0,
  ): Promise<void> {
    return executeGoal(
      run,
      {
        subagents,
        emitChild,
        onEvent: onGoalEvent,
        setTerminal,
      },
      initialIteration,
      run.lastReviewResult,
    );
  }

  function createRun(input: {
    thebeSessionId: string;
    goal: string;
    criteria?: string[];
    maxIterations: number;
  }): ManagedGoal {
    let resolveFinished!: (result: GoalRun) => void;
    const run: ManagedGoal = {
      thebeSessionId: input.thebeSessionId,
      goal: input.goal,
      criteria: input.criteria?.filter(Boolean),
      maxIterations: input.maxIterations,
      iteration: 0,
      status: "running",
      createdAt: ctx.now().toISOString(),
      subagentRunIds: [],
      stopRequested: false,
      pauseRequested: false,
      finished: new Promise<GoalRun>((resolve) => {
        resolveFinished = resolve;
      }),
      resolveFinished,
      listeners: new Set(),
      events: [],
    };
    return run;
  }

  return {
    async startGoal(input: {
      thebeSessionId: string;
      goal: string;
      criteria?: string[];
      maxIterations?: number;
    }): Promise<GoalRun> {
      ctx.checkNotQuiesced();
      const goal = input.goal.trim();
      if (!goal) throw new Error("goal cannot be empty");
      const existing = runs.get(input.thebeSessionId);
      if (existing && (existing.status === "running" || existing.status === "pausing")) {
        throw new Error("a goal is already running for this session");
      }
      if (existing?.status === "paused") {
        throw new Error("goal is paused; use /goal resume");
      }
      await ctx.lookup(input.thebeSessionId);
      const run = createRun({
        thebeSessionId: input.thebeSessionId,
        goal,
        criteria: input.criteria,
        maxIterations: clampIterations(input.maxIterations),
      });
      runs.set(run.thebeSessionId, run);
      await persistGoal(snapshot(run), run.thebeSessionId);
      void runManagedGoal(run);
      return snapshot(run);
    },

    getGoal(thebeSessionId: string): GoalRun | undefined {
      const run = runs.get(thebeSessionId);
      return run ? snapshot(run) : undefined;
    },

    async listGoals(): Promise<GoalRun[]> {
      const metas = await ctx.listMetas();
      const seen = new Set<string>();
      const out: GoalRun[] = [];
      for (const [id, run] of runs) {
        out.push(snapshot(run));
        seen.add(id);
      }
      for (const meta of metas) {
        if (!meta.goalRun || seen.has(meta.thebeSessionId)) continue;
        restoreGoal(meta.goalRun);
        const live = runs.get(meta.thebeSessionId);
        if (live) {
          out.push(snapshot(live));
          seen.add(meta.thebeSessionId);
        }
      }
      return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },

    goalEvents(thebeSessionId: string): Array<{ event: GoalEvent; at: string }> {
      const run = runs.get(thebeSessionId);
      return run ? run.events.map((row) => ({ event: row.event, at: row.at })) : [];
    },

    restoreGoal,

    subscribeGoal(
      thebeSessionId: string,
      listener: (event: GoalEvent) => void,
    ): () => void {
      const run = runs.get(thebeSessionId);
      if (!run) return () => {};
      run.listeners.add(listener);
      return () => run.listeners.delete(listener);
    },

    async waitGoal(thebeSessionId: string): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      return run.status === "running" || run.status === "pausing"
        ? run.finished
        : snapshot(run);
    },

    async pauseGoal(thebeSessionId: string): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      if (run.status !== "running") return snapshot(run);
      run.pauseRequested = true;
      run.status = "pausing";
      broadcast(run, {
        type: "goal_status",
        status: "pausing",
        message: "Stopping the active checkpoint before pausing.",
      });
      const active = run.activeSubagent;
      if (
        active &&
        (active.status === "queued" || active.status === "running")
      ) {
        await subagents.cancelSubagent(active.runId, run.thebeSessionId);
      }
      return snapshot(run);
    },

    async resumeGoal(thebeSessionId: string): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      if (run.status !== "paused") return snapshot(run);
      ctx.checkNotQuiesced();
      run.status = "running";
      resetFinished(run);
      run.finishedAt = undefined;
      run.summary = undefined;
      run.finalReport = undefined;
      run.error = undefined;
      run.pauseRequested = false;
      run.stopRequested = false;
      await persistGoal(snapshot(run), run.thebeSessionId);
      broadcast(run, {
        type: "goal_status",
        status: "running",
        message: "Goal resumed with a fresh isolated worker checkpoint.",
      });
      void runManagedGoal(run, run.iteration);
      return snapshot(run);
    },

    async stopGoal(thebeSessionId: string): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      if (run.status === "paused") {
        return setTerminal(run, "cancelled", "Goal cancelled while paused.");
      }
      if (run.status !== "running" && run.status !== "pausing") {
        return snapshot(run);
      }
      run.stopRequested = true;
      const active = run.activeSubagent;
      if (
        active &&
        (active.status === "queued" || active.status === "running")
      ) {
        await subagents.cancelSubagent(active.runId, run.thebeSessionId);
      }
      return snapshot(run);
    },

    clearGoal(thebeSessionId: string): void {
      const run = runs.get(thebeSessionId);
      if (!run) {
        void persistGoal(undefined, thebeSessionId);
        return;
      }
      if (run.status === "running" || run.status === "pausing") {
        throw new Error("stop or pause the goal before clearing it");
      }
      runs.delete(thebeSessionId);
      run.listeners.clear();
      void persistGoal(undefined, thebeSessionId);
    },
  };
}

function clampIterations(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(50, Math.floor(value as number)));
}
