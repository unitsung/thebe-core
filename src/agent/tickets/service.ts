import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { goalStage } from "../activity/stage-facts.ts";
import type { StageContext } from "../activity/stage.ts";
import { toProductGoal } from "../goals/product.ts";
import type { GoalRun } from "../types.ts";
import { chatTrigger, directTicketId, runTrigger } from "./ids.ts";
import {
  goalTicketKey,
  type Ticket,
  type TicketIndex,
  type TicketView,
} from "./types.ts";

const MAX_TITLE = 200;

/**
 * The ticket store. Tickets are written once, one file each (`<dir>/<id>.json`), and never rewritten;
 * without a directory they live in memory. Goals, sessions, receipts and artifacts keep their own ids and
 * their single writer: the ticket only points at them, and its stage is derived from them on every read.
 */
export function createTicketApi(options: {
  dir?: string;
  listGoals: () => Promise<GoalRun[]>;
  stageContext: () => StageContext;
}) {
  let tickets: Map<string, Ticket> | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  /** Calls run one at a time so accepting the same trigger twice cannot write two tickets. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  async function load(): Promise<Map<string, Ticket>> {
    if (tickets) return tickets;
    const loaded = new Map<string, Ticket>();
    if (options.dir) {
      let names: string[] = [];
      try {
        names = (await readdir(options.dir)).filter((name) =>
          /^[0-9a-f]{32}\.json$/.test(name)
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const name of names) {
        try {
          const ticket = parseStored(
            JSON.parse(await readFile(join(options.dir, name), "utf8"))
          );
          // A file whose name is not its content id was not written by this store; do not trust it.
          if (ticket && `${ticket.id}.json` === name) {
            loaded.set(ticket.id, ticket);
          }
        } catch {
          // An unreadable ticket file must not take the goal and activity endpoints down with it.
        }
      }
    }
    tickets = loaded;
    return loaded;
  }

  async function write(ticket: Ticket): Promise<void> {
    if (!options.dir) return;
    await mkdir(options.dir, { recursive: true });
    const temporary = join(options.dir, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(ticket), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, join(options.dir, `${ticket.id}.json`));
  }

  const newestFirst = (all: Iterable<Ticket>): Ticket[] =>
    [...all].sort((a, b) =>
      a.createdAt < b.createdAt
        ? 1
        : a.createdAt > b.createdAt
          ? -1
          : a.id < b.id
            ? 1
            : -1
    );

  async function view(
    ticket: Ticket,
    goals: GoalRun[],
    context: StageContext
  ): Promise<TicketView> {
    const { legacyGoalId, legacyGoalStartedAt } = ticket.links;
    // The wrapped run is the one that started at the recorded time; a later run on the same session
    // belongs to a later ticket.
    const run = goals.find(
      (goal) =>
        goal.thebeSessionId === legacyGoalId &&
        goal.createdAt === legacyGoalStartedAt
    );
    // Work that no longer exists has nothing left to ask of the owner.
    const stage = run
      ? goalStage(toProductGoal(run), context)
      : ({ kind: "ended" } as const);
    return { ...ticket, stage };
  }

  return {
    /**
     * Records the explicit decision for a goal that was just started. Idempotent: the same trigger
     * returns the ticket it already produced.
     */
    acceptExplicitGoal(input: {
      run: GoalRun;
      /** The caller's own trigger id (a chat message, a request id); absent means the run is the trigger. */
      triggerId?: string;
    }): Promise<Ticket> {
      return serial(async () => {
        const all = await load();
        const { run } = input;
        const trigger = input.triggerId
          ? chatTrigger(input.triggerId)
          : runTrigger(run.thebeSessionId, run.createdAt);
        const id = directTicketId(trigger.thread, trigger.triggerId);
        const existing = all.get(id);
        if (existing) return existing;
        const ticket: Ticket = {
          id,
          title: run.goal.trim().slice(0, MAX_TITLE),
          createdAt: run.createdAt,
          mandate: { strength: "explicit" },
          origin: { kind: "direct", ...trigger },
          links: {
            legacyGoalId: run.thebeSessionId,
            legacyGoalStartedAt: run.createdAt,
            sessionIds: [run.thebeSessionId],
            capabilityRunIds: [],
            receiptIds: [],
            artifactIds: [],
            pipelineJobIds: [],
          },
        };
        await write(ticket);
        all.set(id, ticket);
        return ticket;
      });
    },

    /** The goal an earlier request with this trigger id started, if any. */
    goalForTrigger(triggerId: string): Promise<GoalRun | undefined> {
      return serial(async () => {
        const trigger = chatTrigger(triggerId);
        const ticket = (await load()).get(
          directTicketId(trigger.thread, trigger.triggerId)
        );
        const { legacyGoalId, legacyGoalStartedAt } = ticket?.links ?? {};
        if (!legacyGoalId) return undefined;
        return (await options.listGoals()).find(
          (goal) =>
            goal.thebeSessionId === legacyGoalId &&
            goal.createdAt === legacyGoalStartedAt
        );
      });
    },

    async listTickets(): Promise<TicketView[]> {
      const all = newestFirst((await serial(load)).values());
      const goals = await options.listGoals();
      const context = options.stageContext();
      return Promise.all(all.map((ticket) => view(ticket, goals, context)));
    },

    async getTicket(id: string): Promise<TicketView | undefined> {
      const ticket = (await serial(load)).get(id);
      if (!ticket) return undefined;
      return view(ticket, await options.listGoals(), options.stageContext());
    },

    /** Maps the id a goal endpoint was given (a session id or a ticket id) to the session id. */
    async resolveGoalId(id: string): Promise<string> {
      return (await serial(load)).get(id)?.links.legacyGoalId ?? id;
    },

    async ticketIndex(): Promise<TicketIndex> {
      const index = new Map<string, string>();
      for (const ticket of newestFirst((await serial(load)).values())) {
        const { legacyGoalId, legacyGoalStartedAt } = ticket.links;
        if (!legacyGoalId || !legacyGoalStartedAt) continue;
        index.set(goalTicketKey(legacyGoalId, legacyGoalStartedAt), ticket.id);
      }
      return index;
    },
  };
}

export type TicketApi = ReturnType<typeof createTicketApi>;

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

function parseStored(value: unknown): Ticket | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, any>;
  const links = row.links ?? {};
  const origin = row.origin ?? {};
  if (
    typeof row.id !== "string" ||
    typeof row.title !== "string" ||
    typeof row.createdAt !== "string" ||
    (row.mandate?.strength !== "explicit" &&
      row.mandate?.strength !== "inferred") ||
    origin.kind !== "direct" ||
    typeof origin.thread !== "string" ||
    typeof origin.triggerId !== "string"
  ) {
    return undefined;
  }
  const sessionIds = strings(links.sessionIds);
  const capabilityRunIds = strings(links.capabilityRunIds);
  const receiptIds = strings(links.receiptIds);
  const artifactIds = strings(links.artifactIds);
  const pipelineJobIds = strings(links.pipelineJobIds);
  if (
    !sessionIds ||
    !capabilityRunIds ||
    !receiptIds ||
    !artifactIds ||
    !pipelineJobIds
  ) {
    return undefined;
  }
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    mandate: { strength: row.mandate.strength },
    origin: {
      kind: "direct",
      thread: origin.thread,
      triggerId: origin.triggerId,
    },
    links: {
      ...(typeof links.legacyGoalId === "string"
        ? { legacyGoalId: links.legacyGoalId }
        : {}),
      ...(typeof links.legacyGoalStartedAt === "string"
        ? { legacyGoalStartedAt: links.legacyGoalStartedAt }
        : {}),
      sessionIds,
      capabilityRunIds,
      receiptIds,
      artifactIds,
      pipelineJobIds,
    },
  };
}
