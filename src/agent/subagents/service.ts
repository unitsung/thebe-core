import { randomUUID } from "node:crypto";
import type { NormalizedEvent, RuntimeSession } from "../runtime/index.ts";
import type { SubagentProfile } from "./catalog.ts";
import {
  appendActivity,
  migrateLegacyToolDetail,
  recordEvent,
} from "./activity.ts";
import {
  executeSubagentRun,
  type SubagentExecutionRun,
  type SubagentSessionFactory,
} from "./execution.ts";
import type {
  SubagentRun,
  SubagentRunStatus,
  SubagentUpdate,
} from "../types.ts";
import {
  DEFAULT_AGENT_MAX_SUBAGENT_CONCURRENCY,
  DEFAULT_AGENT_MAX_SUBAGENTS_PER_PARENT,
  normalizeAgentSubagentLimit,
} from "../settings/product.ts";
import { httpError } from "../types.ts";

const DEFAULT_MAX_TURNS = 5;
const MAX_ALLOWED_TURNS = 50;
const MAX_RETAINED_RUNS = 100;
export const SUBAGENT_RUN_INTERRUPTED_ERROR =
  "Subagent run interrupted when Core restarted.";

type MutableRun = SubagentExecutionRun;
export type { SubagentSessionFactory } from "./execution.ts";

export type SubagentRunManager = ReturnType<typeof createSubagentRunManager>;

/**
 * Owns the complete lifecycle of one-shot subagents.
 *
 * The interface intentionally exposes runs, not sessions. The implementation
 * creates an in-memory runtime session only while a queued task is executing,
 * forwards permission requests to the parent control plane, and disposes the
 * runtime session before resolving the terminal run record.
 */
export function createSubagentRunManager(options: {
  now?: () => Date;
  maxConcurrent?: number;
  maxPerParent?: number;
  createSession: SubagentSessionFactory;
  emitToParent?: (parentSessionId: string, event: NormalizedEvent) => void;
  rejectPendingPermission?: (permissionId: string) => boolean;
  onSnapshot?: (run: SubagentRun) => void | Promise<void>;
  beforeTerminal?: (run: SubagentExecutionRun) => void | Promise<void>;
  onTerminal?: (run: SubagentRun) => void | Promise<void>;
}) {
  const now = options.now ?? (() => new Date());
  const maxConcurrent = normalizeAgentSubagentLimit(
    options.maxConcurrent,
    DEFAULT_AGENT_MAX_SUBAGENT_CONCURRENCY,
  );
  const maxPerParent = Math.min(
    maxConcurrent,
    normalizeAgentSubagentLimit(
      options.maxPerParent,
      DEFAULT_AGENT_MAX_SUBAGENTS_PER_PARENT,
    ),
  );
  const runs = new Map<string, MutableRun>();
  const finished = new Set<string>();
  const sessions = new Map<string, RuntimeSession>();
  const pendingByRun = new Map<string, Set<string>>();
  const waiters = new Map<string, Set<(run: SubagentRun) => void>>();
  const listeners = new Map<string, Set<(update: SubagentUpdate) => void>>();
  const allListeners = new Set<{
    parentSessionId?: string;
    listener: (update: SubagentUpdate) => void;
  }>();
  const queue: MutableRun[] = [];
  const activeByParent = new Map<string, number>();
  let activeCount = 0;

  const appendRunActivity = (
    run: MutableRun,
    activity: Parameters<typeof appendActivity>[1],
    merge = false,
  ): void => appendActivity(run, activity, now, merge);
  const recordRunEvent = (run: MutableRun, event: NormalizedEvent): void =>
    recordEvent(run, event, now);

  function snapshot(run: MutableRun): SubagentRun {
    const {
      cancelRequested: _cancelRequested,
      profile: _profile,
      nextActivityId: _nextActivityId,
      ...publicRun
    } = run;
    return {
      ...publicRun,
      activity: publicRun.activity?.map((entry) => ({ ...entry })),
    };
  }

  function terminal(status: SubagentRunStatus): boolean {
    return (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "interrupted"
    );
  }

  async function finish(run: MutableRun): Promise<void> {
    try {
      await options.beforeTerminal?.(run);
    } catch {
      // Persistence must never change the terminal result of a child.
    }
    const result = snapshot(run);
    try {
      await options.onTerminal?.(result);
    } catch {
      // Persistence must never change the terminal result of a child.
    }
    finished.add(run.runId);
    const callbacks = waiters.get(run.runId);
    if (callbacks) {
      waiters.delete(run.runId);
      for (const callback of callbacks) callback(result);
    }
  }

  function notify(run: MutableRun, event?: NormalizedEvent): void {
    const update: SubagentUpdate = { run: snapshot(run), ...(event ? { event } : {}) };
    const callbacks = listeners.get(run.runId);
    if (callbacks) {
      for (const callback of callbacks) callback(update);
    }
    for (const entry of allListeners) {
      if (
        !entry.parentSessionId ||
        entry.parentSessionId === run.parentSessionId
      ) {
        entry.listener(update);
      }
    }
  }

  function removePendingPermissions(run: MutableRun): void {
    const pending = pendingByRun.get(run.runId);
    if (!pending) return;
    for (const permissionId of pending) {
      options.rejectPendingPermission?.(permissionId);
    }
    pendingByRun.delete(run.runId);
  }

  function incrementParent(parentSessionId: string): void {
    activeByParent.set(
      parentSessionId,
      (activeByParent.get(parentSessionId) ?? 0) + 1,
    );
  }

  function decrementParent(parentSessionId: string): void {
    const next = (activeByParent.get(parentSessionId) ?? 1) - 1;
    if (next <= 0) activeByParent.delete(parentSessionId);
    else activeByParent.set(parentSessionId, next);
  }

  function trimHistory(): void {
    if (runs.size <= MAX_RETAINED_RUNS) return;
    for (const [runId, run] of runs) {
      if (runs.size <= MAX_RETAINED_RUNS) break;
      if (terminal(run.status) && !waiters.has(runId)) {
        runs.delete(runId);
        finished.delete(runId);
      }
    }
  }

  function pump(): void {
    while (activeCount < maxConcurrent) {
      const index = queue.findIndex(
        (run) =>
          (activeByParent.get(run.parentSessionId) ?? 0) < maxPerParent,
      );
      if (index < 0) return;
      const [run] = queue.splice(index, 1);
      if (!run || run.cancelRequested) continue;
      activeCount += 1;
      incrementParent(run.parentSessionId);
      void executeSubagentRun(run, {
        now,
        createSession: options.createSession,
        emitToParent: options.emitToParent,
        rejectPendingPermission: options.rejectPendingPermission,
        sessions,
        pendingByRun,
        appendActivity: appendRunActivity,
        recordEvent: recordRunEvent,
        notify,
        finish,
        onSnapshot: (child) => options.onSnapshot?.(snapshot(child)),
        onFinished: () => {
          activeCount -= 1;
          decrementParent(run.parentSessionId);
          trimHistory();
          pump();
        },
      });
    }
  }

  function validateParent(run: MutableRun, parentSessionId?: string): void {
    if (parentSessionId && run.parentSessionId !== parentSessionId) {
      throw new Error("subagent run does not belong to this session");
    }
  }

  function resolveRunId(requestedId: string): string {
    if (runs.has(requestedId)) return requestedId;
    const matches = [...runs.keys()].filter((runId) =>
      runId.startsWith(requestedId),
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`ambiguous subagent run id: ${requestedId}`);
    }
    throw httpError(404, `unknown subagent run: ${requestedId}`);
  }

  async function cancelRun(
    runId: string,
    parentSessionId?: string,
  ): Promise<SubagentRun> {
    const resolvedId = resolveRunId(runId);
    const run = runs.get(resolvedId)!;
    validateParent(run, parentSessionId);
    if (terminal(run.status)) return snapshot(run);
    run.cancelRequested = true;
    if (run.status === "queued") {
      const index = queue.indexOf(run);
      if (index >= 0) queue.splice(index, 1);
      run.status = "cancelled";
      run.finishedAt = now().toISOString();
      notify(run);
      await finish(run);
      trimHistory();
      pump();
      return snapshot(run);
    }
    removePendingPermissions(run);
    await sessions.get(resolvedId)?.abort();
    return snapshot(run);
  }

  async function cancelForParent(parentSessionId: string): Promise<void> {
    const active = [...runs.values()].filter(
      (run) => run.parentSessionId === parentSessionId && !terminal(run.status),
    );
    await Promise.all(
      active.map((run) => cancelRun(run.runId, parentSessionId)),
    );
  }

  return {
    spawn(input: {
      profile: SubagentProfile;
      task: string;
      parentSessionId: string;
    }): SubagentRun {
      const task = input.task.trim();
      if (!task) throw new Error("subagent task cannot be empty");
      const run: MutableRun = {
        runId: randomUUID(),
        parentSessionId: input.parentSessionId,
        profileName: input.profile.name,
        task,
        status: "queued",
        turns: 0,
        maxTurns: normalizeTurns(input.profile.maxTurns),
        createdAt: now().toISOString(),
        activity: [],
        cancelRequested: false,
        profile: input.profile,
        nextActivityId: 1,
      };
      appendRunActivity(run, { kind: "status", title: "queued" });
      runs.set(run.runId, run);
      queue.push(run);
      notify(run);
      pump();
      return snapshot(run);
    },

    list(parentSessionId?: string): SubagentRun[] {
      return [...runs.values()]
        .filter(
          (run) =>
            !parentSessionId || run.parentSessionId === parentSessionId,
        )
        .map(snapshot)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    get(runId: string): SubagentRun | undefined {
      let resolvedId: string;
      try {
        resolvedId = resolveRunId(runId);
      } catch {
        return undefined;
      }
      const run = runs.get(resolvedId);
      return run ? snapshot(run) : undefined;
    },

    subscribe(
      runId: string,
      listener: (update: SubagentUpdate) => void,
    ): () => void {
      let resolvedId: string;
      try {
        resolvedId = resolveRunId(runId);
      } catch {
        return () => {};
      }
      const callbacks = listeners.get(resolvedId) ?? new Set();
      callbacks.add(listener);
      listeners.set(resolvedId, callbacks);
      return () => {
        callbacks.delete(listener);
        if (callbacks.size === 0) listeners.delete(resolvedId);
      };
    },

    subscribeAll(
      parentSessionId: string | undefined,
      listener: (update: SubagentUpdate) => void,
    ): () => void {
      const entry = { parentSessionId, listener };
      allListeners.add(entry);
      return () => allListeners.delete(entry);
    },

    async wait(runId: string): Promise<SubagentRun> {
      const resolvedId = resolveRunId(runId);
      const run = runs.get(resolvedId)!;
      if (finished.has(resolvedId)) return snapshot(run);
      return new Promise((resolve) => {
        const callbacks = waiters.get(resolvedId) ?? new Set();
        callbacks.add(resolve);
        waiters.set(resolvedId, callbacks);
      });
    },

    cancel: cancelRun,
    cancelForParent,

    /** Rehydrate child records without creating a runtime session. */
    restore(restoredRuns: SubagentRun[]): SubagentRun[] {
      const recovered: SubagentRun[] = [];
      for (const record of restoredRuns) {
        if (runs.has(record.runId) || (!terminal(record.status) && !active(record.status))) continue;
        const recoveryAt = active(record.status) ? now().toISOString() : undefined;
        const activity = (record.activity ?? []).map((entry) => {
          const restored = { ...entry };
          migrateLegacyToolDetail(restored);
          return restored;
        });
        let nextActivityId = Math.max(
          0,
          ...activity.map((entry) => entry.id),
        ) + 1;
        const recoveredRecord: SubagentRun = active(record.status)
          ? {
              ...record,
              status: "interrupted",
              finishedAt: recoveryAt,
              error: SUBAGENT_RUN_INTERRUPTED_ERROR,
            }
          : record;
        if (recoveryAt) {
          activity.push({
            id: nextActivityId++,
            at: recoveryAt,
            kind: "status",
            title: "interrupted",
          });
        }
        const restored: MutableRun = {
          ...recoveredRecord,
          activity,
          cancelRequested: false,
          profile: restoredProfile(recoveredRecord),
          nextActivityId,
        };
        runs.set(restored.runId, restored);
        if (terminal(restored.status)) finished.add(restored.runId);
        if (recoveryAt) recovered.push(snapshot(restored));
      }
      trimHistory();
      return recovered;
    },

    limits: {
      maxConcurrent,
      maxPerParent,
      maxTurns: MAX_ALLOWED_TURNS,
    },
  };
}

function normalizeTurns(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_TURNS;
  return Math.max(1, Math.min(MAX_ALLOWED_TURNS, Math.floor(value as number)));
}

function active(status: SubagentRunStatus): boolean {
  return status === "queued" || status === "running";
}

function restoredProfile(run: SubagentRun): SubagentProfile {
  return {
    name: run.profileName,
    description: "Restored completed subagent run",
    filePath: "",
    scope: "builtin",
    systemPrompt: "",
  };
}
