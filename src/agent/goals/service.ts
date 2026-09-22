import type { GoalEvent } from "../goals/runner.ts";
import {
  executeGoal,
  type GoalSubagentApi,
  type ManagedGoal,
} from "./execution.ts";
import type {
  GoalRun,
  GoalRunStatus,
  SubagentRun,
  SubagentUpdate,
} from "../types.ts";
import type { AgentContext } from "../internal/context.ts";
import type { StoredGoalEvent } from "../store.ts";

const MAX_GOAL_EVENTS = 50;

export function createGoalApi(
  ctx: AgentContext,
  subagents: GoalSubagentApi,
) {
  const runs = new Map<string, ManagedGoal>();
  const persistChains = new Map<string, Promise<void>>();

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

  const RECOVERY_MESSAGE =
    "Goal recovered as paused after Core restart; resume it to continue.";

  function broadcast(run: ManagedGoal, event: GoalEvent): void {
    run.events.push({ event, at: ctx.now().toISOString() });
    if (run.events.length > MAX_GOAL_EVENTS) {
      run.events.splice(0, run.events.length - MAX_GOAL_EVENTS);
    }
    void queueGoalPersistence(
      snapshot(run),
      run.thebeSessionId,
      storedGoalEvents(run.events),
    );
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
    await queueGoalPersistence(
      result,
      run.thebeSessionId,
      storedGoalEvents(run.events),
    );
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
    events: StoredGoalEvent[] = [],
  ): Promise<void> {
    try {
      const meta = await ctx.lookup(thebeSessionId);
      await ctx.persist(
        ctx.touchMeta({
          ...meta,
          goalRun: run,
          goalEvents: run ? events.slice(-MAX_GOAL_EVENTS) : undefined,
        }),
      );
    } catch {
      // A persistence failure must not turn a completed Goal into a failure.
    }
  }

  function queueGoalPersistence(
    run: GoalRun | undefined,
    thebeSessionId: string,
    events: StoredGoalEvent[] = [],
  ): Promise<void> {
    const previous = persistChains.get(thebeSessionId) ?? Promise.resolve();
    const next = previous.then(
      () => persistGoal(run, thebeSessionId, events),
      () => persistGoal(run, thebeSessionId, events),
    );
    persistChains.set(thebeSessionId, next);
    void next.then(
      () => {
        if (persistChains.get(thebeSessionId) === next) {
          persistChains.delete(thebeSessionId);
        }
      },
      () => {
        if (persistChains.get(thebeSessionId) === next) {
          persistChains.delete(thebeSessionId);
        }
      },
    );
    return next;
  }

  function restoreGoal(
    persisted: GoalRun | undefined,
    persistedEvents: StoredGoalEvent[] = [],
  ): void {
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
    run.events = restoreEvents(persistedEvents, persisted.thebeSessionId);
    run.summary = interrupted
      ? `Goal paused after ${run.iteration} checkpoint(s); resume it to continue.`
      : persisted.summary;
    run.finalReport = persisted.finalReport;
    run.error = interrupted
      ? "The previous Goal process ended before its active checkpoint completed."
      : persisted.error;
    if (interrupted) {
      run.events.push({
        event: {
          type: "goal_status",
          status: "paused",
          message: RECOVERY_MESSAGE,
        },
        at: ctx.now().toISOString(),
      });
    }
    runs.set(run.thebeSessionId, run);
    if (interrupted) {
      void queueGoalPersistence(
        snapshot(run),
        run.thebeSessionId,
        storedGoalEvents(run.events),
      );
    }
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
      await queueGoalPersistence(
        snapshot(run),
        run.thebeSessionId,
        storedGoalEvents(run.events),
      );
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
        restoreGoal(meta.goalRun, meta.goalEvents);
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
      await queueGoalPersistence(
        snapshot(run),
        run.thebeSessionId,
        storedGoalEvents(run.events),
      );
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
        void queueGoalPersistence(undefined, thebeSessionId);
        return;
      }
      if (run.status === "running" || run.status === "pausing") {
        throw new Error("stop or pause the goal before clearing it");
      }
      runs.delete(thebeSessionId);
      run.listeners.clear();
      void queueGoalPersistence(undefined, thebeSessionId);
    },
  };
}

function storedGoalEvents(
  events: Array<{ event: GoalEvent; at: string }>,
): StoredGoalEvent[] {
  return events.slice(-MAX_GOAL_EVENTS).map(toStoredGoalEvent);
}

function toStoredGoalEvent(row: {
  event: GoalEvent;
  at: string;
}): StoredGoalEvent {
  const event = row.event;
  switch (event.type) {
    case "goal_started":
      return {
        at: row.at,
        event: {
          type: event.type,
          goal: event.goal,
          criteria: event.criteria?.slice(),
          maxIterations: event.maxIterations,
        },
      };
    case "goal_iteration":
      return {
        at: row.at,
        event: {
          type: event.type,
          iteration: event.iteration,
          maxIterations: event.maxIterations,
        },
      };
    case "goal_reviewed":
      return {
        at: row.at,
        event: {
          type: event.type,
          iteration: event.iteration,
          complete: event.complete,
          score: event.score,
          critique: boundedText(event.critique, 400),
          remainingTasks: event.remainingTasks?.slice(),
        },
      };
    case "goal_completed":
      return {
        at: row.at,
        event: {
          type: event.type,
          status: event.status,
          totalIterations: event.totalIterations,
          summary: event.summary,
        },
      };
    case "goal_subagent_update":
      return {
        at: row.at,
        event: {
          type: event.type,
          iteration: event.iteration,
          role: event.role,
          run: {
            runId: event.run.runId,
            profileName: event.run.profileName,
            status: event.run.status,
          },
        },
      };
    case "goal_status":
      return {
        at: row.at,
        event: {
          type: event.type,
          status: event.status,
          message: event.message,
        },
      };
  }
}

function restoreEvents(
  events: StoredGoalEvent[],
  parentSessionId: string,
): Array<{ event: GoalEvent; at: string }> {
  return events
    .filter(
      (row) =>
        Boolean(row) &&
        typeof row.at === "string" &&
        Boolean(row.event) &&
        typeof row.event.type === "string",
    )
    .slice(-MAX_GOAL_EVENTS)
    .map((row) => ({
      at: row.at,
      event: restoreEvent(row.event, parentSessionId, row.at),
    }));
}

function restoreEvent(
  event: StoredGoalEvent["event"],
  parentSessionId: string,
  at: string,
): GoalEvent {
  if (event.type !== "goal_subagent_update") {
    return event;
  }
  const run: SubagentRun = {
    runId: event.run.runId,
    parentSessionId,
    profileName: event.run.profileName,
    task: "",
    status: event.run.status,
    turns: 0,
    maxTurns: 0,
    createdAt: at,
  };
  return {
    type: event.type,
    iteration: event.iteration,
    role: event.role,
    run,
  };
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function clampIterations(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(50, Math.floor(value as number)));
}
