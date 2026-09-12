import { randomUUID } from "node:crypto";
import type { NormalizedEvent, RuntimeSession } from "../../runtime/types.ts";
import type { SubagentProfile } from "../resources/subagents.ts";
import type { SubagentRun, SubagentRunStatus } from "../types.ts";

const DEFAULT_MAX_TURNS = 5;
const MAX_ALLOWED_TURNS = 50;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_PER_PARENT = 2;
const MAX_RETAINED_RUNS = 100;

type MutableRun = SubagentRun & {
  cancelRequested: boolean;
  profile: SubagentProfile;
};

export type SubagentSessionFactory = (input: {
  runId: string;
  parentSessionId: string;
  profile: SubagentProfile;
}) => Promise<RuntimeSession>;

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
}) {
  const now = options.now ?? (() => new Date());
  const maxConcurrent = normalizeLimit(
    options.maxConcurrent,
    DEFAULT_MAX_CONCURRENT,
  );
  const maxPerParent = Math.min(
    maxConcurrent,
    normalizeLimit(options.maxPerParent, DEFAULT_MAX_PER_PARENT),
  );
  const runs = new Map<string, MutableRun>();
  const sessions = new Map<string, RuntimeSession>();
  const pendingByRun = new Map<string, Set<string>>();
  const waiters = new Map<string, Set<(run: SubagentRun) => void>>();
  const queue: MutableRun[] = [];
  const activeByParent = new Map<string, number>();
  let activeCount = 0;

  function snapshot(run: MutableRun): SubagentRun {
    const { cancelRequested: _cancelRequested, profile: _profile, ...publicRun } = run;
    return publicRun;
  }

  function terminal(status: SubagentRunStatus): boolean {
    return (
      status === "completed" || status === "failed" || status === "cancelled"
    );
  }

  function finish(run: MutableRun): void {
    const callbacks = waiters.get(run.runId);
    if (callbacks) {
      waiters.delete(run.runId);
      const result = snapshot(run);
      for (const callback of callbacks) callback(result);
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
      if (terminal(run.status) && !waiters.has(runId)) runs.delete(runId);
    }
  }

  async function execute(run: MutableRun): Promise<void> {
    let session: RuntimeSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let maxTurnsReached = false;
    const pending = new Set<string>();
    pendingByRun.set(run.runId, pending);
    try {
      run.status = "running";
      run.startedAt = now().toISOString();
      session = await options.createSession({
        runId: run.runId,
        parentSessionId: run.parentSessionId,
        profile: runProfile(run),
      });
      sessions.set(run.runId, session);
      if (run.cancelRequested) {
        await session.abort();
        run.status = "cancelled";
        return;
      }
      unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_end") {
          run.turns += 1;
          if (run.turns >= run.maxTurns && !maxTurnsReached) {
            maxTurnsReached = true;
            void session?.abort().catch(() => {});
          }
        }
        if (event.type === "permission_requested") {
          pending.add(event.permissionId);
          options.emitToParent?.(run.parentSessionId, event);
        }
      });
      await session.prompt(run.task);
      run.result = session.lastAssistantText().trim();
      run.status = run.cancelRequested ? "cancelled" : "completed";
      if (maxTurnsReached && !run.result) {
        run.error = `subagent reached its ${run.maxTurns}-turn limit`;
      }
    } catch (error) {
      if (run.cancelRequested) {
        run.status = "cancelled";
      } else if (maxTurnsReached) {
        run.status = "completed";
        run.result = session?.lastAssistantText().trim() || undefined;
      } else {
        run.status = "failed";
        run.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      unsubscribe?.();
      removePendingPermissions(run);
      sessions.delete(run.runId);
      session?.dispose();
      run.finishedAt = now().toISOString();
      activeCount -= 1;
      decrementParent(run.parentSessionId);
      finish(run);
      trimHistory();
      pump();
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
      void execute(run);
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
    throw new Error(`unknown subagent run: ${requestedId}`);
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
      finish(run);
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
        cancelRequested: false,
        profile: input.profile,
      };
      runs.set(run.runId, run);
      queue.push(run);
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

    async wait(runId: string): Promise<SubagentRun> {
      const resolvedId = resolveRunId(runId);
      const run = runs.get(resolvedId)!;
      if (terminal(run.status)) return snapshot(run);
      return new Promise((resolve) => {
        const callbacks = waiters.get(resolvedId) ?? new Set();
        callbacks.add(resolve);
        waiters.set(resolvedId, callbacks);
      });
    },

    cancel: cancelRun,
    cancelForParent,

    limits: {
      maxConcurrent,
      maxPerParent,
      maxTurns: MAX_ALLOWED_TURNS,
    },
  };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(16, Math.floor(value as number)));
}

function normalizeTurns(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_TURNS;
  return Math.max(1, Math.min(MAX_ALLOWED_TURNS, Math.floor(value as number)));
}

function runProfile(run: MutableRun): SubagentProfile {
  return run.profile;
}
