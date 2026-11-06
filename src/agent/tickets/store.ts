import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { directEvalId, ticketIdFor } from "./ids.ts";
import type { Ticket } from "./types.ts";

export const DEFAULT_TICKET_RETENTION = 500;

const ID_RE = /^[a-f0-9]{32}$/;

export type TicketStore = {
  get(id: string): Promise<Ticket | undefined>;
  getByGoal(goalId: string): Promise<Ticket | undefined>;
  list(): Promise<Ticket[]>;
  /**
   * Records the Ticket for work a person asked for. Idempotent: the same request gives the same Ticket,
   * so a retry does not create a second one.
   */
  recordDirect(input: {
    thread: string;
    triggerId: string;
    kind: string;
    /** When the request happened. Part of the id, so a retry of the same request must pass the same time. */
    at: string;
    title: string;
    requester: string;
    goalId?: string;
    sessionIds?: string[];
  }): Promise<Ticket>;
  /**
   * Records the Ticket for work Eval took on under the person's policy. Its id derives from the Eval, so a
   * Decision made again after a crash gives the same Ticket and not a second one.
   */
  recordAccepted(input: {
    evalId: string;
    decisionId: string;
    thread: string;
    /** When the newest Trigger happened; the Ticket's time, so a retry is the same. */
    at: string;
    title: string;
    requester: string;
    policyVersion: string;
    matchedRuleIds: string[];
    scope: string[];
    intent?: string;
    /** The Goal that carries it out. Its session id: the Ticket's Mandate is looked up from it. */
    goalId?: string;
    receiptIds?: string[];
  }): Promise<Ticket>;
};

export function createTicketStore(options: {
  dir?: string;
  maxItems?: number;
}): TicketStore {
  const maxItems = options.maxItems ?? DEFAULT_TICKET_RETENTION;
  const memory = new Map<string, Ticket>();
  let loaded = !options.dir;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    if (!options.dir) return;
    let names: string[] = [];
    try {
      names = (await readdir(options.dir)).filter(
        (name) => name.endsWith(".json") && !name.endsWith(".tmp.json")
      );
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const parsed = JSON.parse(
          await readFile(join(options.dir, name), "utf8")
        ) as Ticket;
        if (parsed && ID_RE.test(parsed.id)) memory.set(parsed.id, parsed);
      } catch {
        // A damaged file is skipped, not fatal.
      }
    }
  }

  async function persist(ticket: Ticket): Promise<void> {
    if (!options.dir) return;
    await mkdir(options.dir, { recursive: true });
    const target = join(options.dir, `${ticket.id}.json`);
    const temp = join(options.dir, `${ticket.id}.${process.pid}.tmp.json`);
    await writeFile(temp, `${JSON.stringify(ticket)}\n`, "utf8");
    await rename(temp, target);
  }

  async function prune(): Promise<void> {
    if (memory.size <= maxItems) return;
    const ordered = newestFirst([...memory.values()]).reverse();
    for (const old of ordered.slice(0, memory.size - maxItems)) {
      memory.delete(old.id);
      if (options.dir) {
        await unlink(join(options.dir, `${old.id}.json`)).catch(() => {});
      }
    }
  }

  return {
    async get(id) {
      await ensureLoaded();
      return ID_RE.test(id) ? memory.get(id) : undefined;
    },
    async getByGoal(goalId) {
      await ensureLoaded();
      return [...memory.values()].find(
        (ticket) => ticket.links.legacyGoalId === goalId
      );
    },
    async list() {
      await ensureLoaded();
      return newestFirst([...memory.values()]);
    },
    async recordDirect(input) {
      await ensureLoaded();
      const evalId = directEvalId({
        thread: input.thread,
        triggerId: input.triggerId,
        kind: input.kind,
        at: input.at,
      });
      const id = ticketIdFor(evalId);
      const existing = memory.get(id);
      if (existing) return existing;
      const ticket: Ticket = {
        id,
        title: input.title,
        mandate: {
          strength: "explicit",
          decidedBy: "direct",
          evalId,
          requester: input.requester,
        },
        subscriptions: [input.thread],
        links: {
          ...(input.goalId ? { legacyGoalId: input.goalId } : {}),
          sessionIds: input.sessionIds ?? [],
        },
        createdAt: input.at,
      };
      memory.set(id, ticket);
      await persist(ticket);
      await prune();
      return ticket;
    },
    async recordAccepted(input) {
      await ensureLoaded();
      const id = ticketIdFor(input.evalId);
      const existing = memory.get(id);
      if (existing) return existing;
      const ticket: Ticket = {
        id,
        title: input.title,
        mandate: {
          strength: "inferred",
          decidedBy: "eval",
          evalId: input.evalId,
          requester: input.requester,
          policyVersion: input.policyVersion,
          matchedRuleIds: input.matchedRuleIds,
          scope: input.scope,
          ...(input.intent ? { intent: input.intent } : {}),
        },
        subscriptions: [input.thread],
        links: {
          decisionId: input.decisionId,
          ...(input.goalId ? { legacyGoalId: input.goalId } : {}),
          sessionIds: input.goalId ? [input.goalId] : [],
          ...(input.receiptIds?.length ? { receiptIds: input.receiptIds } : {}),
        },
        createdAt: input.at,
      };
      memory.set(id, ticket);
      await persist(ticket);
      await prune();
      return ticket;
    },
  };
}

function newestFirst(tickets: Ticket[]): Ticket[] {
  return tickets.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
}
