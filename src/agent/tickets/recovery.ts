import type { GoalRun } from "../types.ts";
import type { StoredGoalEvent } from "../store.ts";
import type { MandateRevalidation } from "./mandate.ts";
import type { TicketStore } from "./store.ts";

/**
 * The Goal side of a Ticket's execution lifecycle: a Goal runs one Assignment at a time and keeps its
 * own status. Core persists that status with the session, so a Ticket assignment interrupted by a
 * restart can be found and continued without asking the person to resume work they already approved.
 */
export type TicketAssignmentState = "pending" | "running" | "waiting" | "ended";

export type RecoverableTicketGoal = {
  ticketId: string;
  goalId: string;
};

/**
 * Resumes Ticket Goals that were mid-checkpoint when the previous Core process ended. It never
 * resumes work that a person paused, stopped, or that is waiting for an answer or review; those are
 * deliberate states, not an interruption. A Goal whose Mandate no longer revalidates stays paused.
 * A `pausing` Goal is restored into its paused state but is never resumed.
 */
export async function recoverInterruptedTicketGoals(options: {
  tickets: Pick<TicketStore, "list">;
  lookup: (goalId: string) => Promise<{
    goalRun?: GoalRun;
    goalEvents?: StoredGoalEvent[];
  }>;
  restore: (goal: GoalRun, events?: StoredGoalEvent[]) => void;
  revalidate: (goalId: string) => Promise<MandateRevalidation>;
  resume: (goalId: string) => Promise<unknown>;
  onError?: (goalId: string, error: unknown) => void;
}): Promise<RecoverableTicketGoal[]> {
  const recovered: RecoverableTicketGoal[] = [];
  for (const ticket of await options.tickets.list()) {
    const goalId = ticket.links.legacyGoalId;
    if (!goalId) continue;
    let meta: Awaited<ReturnType<typeof options.lookup>>;
    try {
      meta = await options.lookup(goalId);
    } catch (error) {
      options.onError?.(goalId, error);
      continue;
    }
    const goal = meta.goalRun;
    if (!goal || goal.executor !== "ticket") continue;
    if (goal.status !== "running" && goal.status !== "pausing") continue;
    // `pausing` is a person's (or Watchdog's) deliberate pause in flight, not an interruption.
    // Restoring it keeps the Goal paused where the view can show it; resuming would undo the pause.
    const interrupted = goal.status === "running";
    try {
      options.restore(goal, meta.goalEvents);
      if (!interrupted) continue;
      const revalidation = await options.revalidate(goalId);
      if (!revalidation.allowed) continue;
      await options.resume(goalId);
      recovered.push({ ticketId: ticket.id, goalId });
    } catch (error) {
      // A resumed run that cannot start stays paused; the Ticket view shows why instead of
      // silently retrying forever.
      options.onError?.(goalId, error);
    }
  }
  return recovered;
}
