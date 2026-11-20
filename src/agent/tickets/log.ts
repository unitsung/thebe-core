import type { BufferedGoalEvent } from "../goals/execution.ts";
import { toProductGoalEvent } from "../goals/product.ts";

function ticketEvent(ticketId: string, row: BufferedGoalEvent) {
  const {
    goalId: _goalId,
    type,
    ...event
  } = toProductGoalEvent(ticketId, row.event, row.sequence, row.at);
  return { ...event, ticketId, type: type.replace(/^goal_/, "ticket_") };
}

export type TicketExecutionLog = ReturnType<typeof createTicketExecutionLog>;

export function createTicketExecutionLog(
  ticketId: string,
  rows: () => readonly BufferedGoalEvent[],
  subscribe: (listener: () => void) => () => void,
  finished: () => boolean
) {
  return {
    read(after: number) {
      const history = rows();
      return {
        events: history
          .filter((row) => row.sequence > after)
          .map((row) => ticketEvent(ticketId, row)),
        next: Math.max(after, history.at(-1)?.sequence ?? 0),
      };
    },
    subscribe,
    finished,
  };
}
