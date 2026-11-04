import { toProductGoal } from "../goals/product.ts";
import type { GoalRun } from "../types.ts";
import { createTicketApi } from "./service.ts";

/**
 * Tickets, goals with and without their ticket id, and the health capability, exported as data for the
 * App's decoders. Core owns the file and builds the tickets with the real store, so the two cannot drift.
 * Every ticket field is additive: `legacy` holds the responses of a Core that predates tickets, and the
 * App must decode both.
 */
export const TICKETS_CONTRACT_PATH = "contracts/tickets.json";

const T0 = "2026-11-04T09:00:00.000Z";
const T1 = "2026-11-04T09:30:00.000Z";
const NOW = new Date("2026-11-04T10:00:00.000Z");

function goal(overrides: Partial<GoalRun>): GoalRun {
  return {
    thebeSessionId: "goal-1",
    goal: "Tidy the media library",
    maxIterations: 8,
    iteration: 1,
    status: "running",
    createdAt: T0,
    updatedAt: T1,
    subagentRunIds: [],
    ...overrides,
  };
}

export async function buildTicketsContract() {
  const asking = goal({
    status: "paused",
    summary: "Goal paused: waiting for your answer.",
    report: {
      state: "waiting",
      summary: "Two folders match.",
      at: T1,
      role: "worker",
    },
    attention: {
      question: "Which folder should I clean?",
      askedAt: T1,
      role: "worker",
    },
  });
  const done = goal({
    thebeSessionId: "goal-2",
    goal: "Check the backups",
    status: "completed",
    createdAt: "2026-11-04T08:00:00.000Z",
    finishedAt: T0,
  });
  const runs = [asking, done];
  const api = createTicketApi({
    listGoals: async () => runs,
    stageContext: () => ({ now: NOW }),
  });
  await api.acceptExplicitGoal({ run: done });
  await api.acceptExplicitGoal({ run: asking, triggerId: "chat-message-42" });
  const tickets = await api.listTickets();
  const index = await api.ticketIndex();
  const [first] = tickets;
  return {
    version: 1,
    /** `GET /v1/tickets`: newest first, each with its derived stage. */
    list: { tickets },
    /** `GET /v1/tickets/{id}`. */
    item: first,
    /** A goal response that carries its ticket id, and the same goal from a Core without tickets. */
    goal: {
      withTicketId: toProductGoal(asking, index.get(`goal:goal-1:${T0}`)),
      legacy: toProductGoal(asking),
    },
    /** `GET /v1/health`: the capability advertised, and a Core that advertises none. */
    health: {
      withTickets: {
        ok: true,
        version: "0.1.0",
        capabilities: { tickets: true },
      },
      legacy: { ok: true, version: "0.1.0" },
    },
  };
}
