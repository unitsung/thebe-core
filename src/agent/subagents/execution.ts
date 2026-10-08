import type { NormalizedEvent, RuntimeSession } from "../runtime/index.ts";
import type { SubagentProfile } from "./catalog.ts";
import { appendActivity, recordEvent, type ActivityRun } from "./activity.ts";
import type { SubagentRun } from "../types.ts";

export type SubagentExecutionRun = ActivityRun & {
  cancelRequested: boolean;
  profile: SubagentProfile;
  nextActivityId: number;
};

export type SubagentSessionFactory = (input: {
  runId: string;
  parentSessionId: string;
  profile: SubagentProfile;
}) => Promise<RuntimeSession>;

export type SubagentExecutionDeps = {
  now: () => Date;
  createSession: SubagentSessionFactory;
  emitToParent?: (parentSessionId: string, event: NormalizedEvent) => void;
  rejectPendingPermission?: (permissionId: string) => boolean;
  sessions: Map<string, RuntimeSession>;
  pendingByRun: Map<string, Set<string>>;
  appendActivity: (run: SubagentExecutionRun, activity: Parameters<typeof appendActivity>[1], merge?: boolean) => void;
  recordEvent: (run: SubagentExecutionRun, event: NormalizedEvent) => void;
  notify: (run: SubagentExecutionRun, event?: NormalizedEvent) => void;
  onSnapshot?: (run: SubagentExecutionRun) => void | Promise<void>;
  finish: (run: SubagentExecutionRun) => Promise<void>;
  onFinished: (run: SubagentExecutionRun) => void;
};

/** Executes exactly one ephemeral child and returns only its retained record. */
export async function executeSubagentRun(
  run: SubagentExecutionRun,
  deps: SubagentExecutionDeps,
): Promise<void> {
  let session: RuntimeSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let maxTurnsReached = false;
  const pending = new Set<string>();
  deps.pendingByRun.set(run.runId, pending);
  try {
    run.status = "running";
    run.startedAt = deps.now().toISOString();
    deps.appendActivity(run, { kind: "status", title: "running" });
    await deps.onSnapshot?.(run);
    deps.notify(run);
    session = await deps.createSession({ runId: run.runId, parentSessionId: run.parentSessionId, profile: run.profile });
    deps.sessions.set(run.runId, session);
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
        deps.emitToParent?.(run.parentSessionId, event);
      }
      deps.recordEvent(run, event);
      deps.notify(run, event);
    });
    await session.prompt(run.task);
    run.result = session.lastAssistantText().trim();
    run.responseText = run.responseText || run.result || undefined;
    run.status = run.cancelRequested ? "cancelled" : "completed";
    if (maxTurnsReached && !run.result && !run.cancelRequested) {
      run.status = "failed";
      run.error = `subagent reached its ${run.maxTurns}-turn limit`;
    }
  } catch (error) {
    if (run.cancelRequested) run.status = "cancelled";
    else if (maxTurnsReached) {
      run.status = "failed";
      run.result = session?.lastAssistantText().trim() || undefined;
      run.error = `subagent reached its ${run.maxTurns}-turn limit`;
    } else {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    unsubscribe?.();
    for (const permissionId of pending) deps.rejectPendingPermission?.(permissionId);
    deps.pendingByRun.delete(run.runId);
    deps.sessions.delete(run.runId);
    session?.dispose();
    run.finishedAt = deps.now().toISOString();
    deps.appendActivity(run, { kind: "status", title: run.status });
    await deps.finish(run);
    deps.notify(run);
    deps.onFinished(run);
  }
}
