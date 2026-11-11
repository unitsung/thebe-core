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
import type { Ticket, TicketInput, TicketOrigin } from "./types.ts";
import type { ChannelRef, Trigger } from "../sources/types.ts";

export const DEFAULT_TICKET_RETENTION = 500;
export const MAX_INPUTS_PER_TICKET = 200;

const ID_RE = /^[a-f0-9]{32}$/;

export type TicketStore = {
  get(id: string): Promise<Ticket | undefined>;
  getByGoal(goalId: string): Promise<Ticket | undefined>;
  getByDecision(decisionId: string): Promise<Ticket | undefined>;
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
    /** Replaces time in the derived id when a caller supplies a stable retry key. */
    idempotencyKey?: string;
    title: string;
    requester: string;
    goalId?: string;
    sessionIds?: string[];
    subscriptions?: string[];
    /** Source events explicitly routed to this direct Ticket by the Main Session. */
    triggers?: readonly Trigger[];
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
    /** Source events that produced the accepted work; their identity does not change the Mandate. */
    triggers?: readonly Trigger[];
    intent?: string;
    /** The Goal that carries it out. Its session id: the Ticket's Mandate is looked up from it. */
    goalId?: string;
  }): Promise<Ticket>;
  /**
   * Records work a person explicitly took on after reviewing an Eval candidate. The Decision remains
   * unchanged as evidence; this Ticket links back to it and derives its id from the same Eval.
   */
  recordDecisionAccepted(input: {
    evalId: string;
    decisionId: string;
    thread: string;
    at: string;
    title: string;
    requester: string;
    goalId: string;
    /** Source events behind the person-reviewed Decision. */
    triggers?: readonly Trigger[];
  }): Promise<Ticket>;
  /**
   * Fan-out: attaches a Trigger to the newest live Ticket subscribed to any of its threads.
   * Returns the ticket id if attached, or an empty array if no live subscriber was found.
   */
  attachTrigger(options: {
    trigger: Trigger;
    isLive: (ticket: Ticket) => Promise<boolean> | boolean;
    attachedAt?: string;
  }): Promise<string[]>;
  /**
   * Attaches Triggers explicitly to one Ticket, subscribing it to every Thread they belong to.
   * Idempotent by Trigger id, so retrying the same routing does not duplicate an Input.
   */
  attachToTicket(options: {
    ticketId: string;
    triggers: readonly Trigger[];
    note?: string;
    attachedAt?: string;
  }): Promise<
    | {
        ticket: Ticket;
        addedTriggerIds: string[];
        reused: boolean;
      }
    | undefined
  >;
  /** Removes every Ticket's subscription to one Thread without ending or changing its work. */
  unsubscribeThread(thread: string): Promise<string[]>;
};

export function createTicketStore(options: {
  dir?: string;
  maxItems?: number;
}): TicketStore {
  const maxItems = options.maxItems ?? DEFAULT_TICKET_RETENTION;
  const memory = new Map<string, Ticket>();
  let loaded = !options.dir;
  let chain: Promise<unknown> = Promise.resolve();

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

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
        if (parsed && ID_RE.test(parsed.id)) {
          parsed.inputs = Array.isArray(parsed.inputs) ? parsed.inputs : [];
          parsed.subscriptions = Array.isArray(parsed.subscriptions)
            ? parsed.subscriptions
            : [];
          parsed.origins = Array.isArray(parsed.origins) ? parsed.origins : [];
          parsed.channels = Array.isArray(parsed.channels)
            ? parsed.channels
            : [];
          memory.set(parsed.id, parsed);
        }
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
    async getByDecision(decisionId) {
      await ensureLoaded();
      return [...memory.values()].find(
        (ticket) => ticket.links.decisionId === decisionId
      );
    },
    async list() {
      await ensureLoaded();
      return newestFirst([...memory.values()]);
    },
    async recordDirect(input) {
      return serial(async () => {
        await ensureLoaded();
        const evalId = directEvalId({
          thread: input.thread,
          triggerId: input.triggerId,
          kind: input.kind,
          at: input.at,
          ...(input.idempotencyKey
            ? { idempotencyKey: input.idempotencyKey }
            : {}),
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
          subscriptions: [
            ...new Set([
              input.thread,
              ...(input.subscriptions ?? []),
              ...(input.triggers ?? []).flatMap((trigger) => trigger.threads),
            ]),
          ],
          inputs: [],
          origins: originsFor(input.triggers ?? []),
          channels: channelsFor(input.triggers ?? []),
          links: {
            ...(input.goalId ? { legacyGoalId: input.goalId } : {}),
            ...(input.idempotencyKey
              ? { requestId: input.idempotencyKey }
              : {}),
            sessionIds: input.sessionIds ?? [],
          },
          createdAt: input.at,
        };
        memory.set(id, ticket);
        await persist(ticket);
        await prune();
        return ticket;
      });
    },
    async recordAccepted(input) {
      return serial(async () => {
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
          inputs: [],
          origins: originsFor(input.triggers ?? []),
          channels: channelsFor(input.triggers ?? []),
          links: {
            decisionId: input.decisionId,
            ...(input.goalId ? { legacyGoalId: input.goalId } : {}),
            sessionIds: input.goalId ? [input.goalId] : [],
          },
          createdAt: input.at,
        };
        memory.set(id, ticket);
        await persist(ticket);
        await prune();
        return ticket;
      });
    },
    async recordDecisionAccepted(input) {
      return serial(async () => {
        await ensureLoaded();
        const id = ticketIdFor(input.evalId);
        const existing = memory.get(id);
        if (existing) return existing;
        const ticket: Ticket = {
          id,
          title: input.title,
          mandate: {
            strength: "explicit",
            decidedBy: "direct",
            evalId: input.evalId,
            requester: input.requester,
          },
          subscriptions: [input.thread],
          inputs: [],
          origins: originsFor(input.triggers ?? []),
          channels: channelsFor(input.triggers ?? []),
          links: {
            decisionId: input.decisionId,
            legacyGoalId: input.goalId,
            sessionIds: [input.goalId],
          },
          createdAt: input.at,
        };
        memory.set(id, ticket);
        await persist(ticket);
        await prune();
        return ticket;
      });
    },
    async attachTrigger(options) {
      return serial(async () => {
        await ensureLoaded();
        for (const ticket of memory.values()) {
          if (
            ticket.inputs.some((item) => item.triggerId === options.trigger.id)
          ) {
            return [ticket.id];
          }
        }
        const matchingTickets = [...memory.values()].filter((ticket) =>
          ticket.subscriptions.some((sub) =>
            options.trigger.threads.some(
              (thread) => normalizeThread(sub) === normalizeThread(thread)
            )
          )
        );
        if (matchingTickets.length === 0) return [];
        const liveMatches: Ticket[] = [];
        for (const ticket of matchingTickets) {
          if (await options.isLive(ticket)) {
            liveMatches.push(ticket);
          }
        }
        if (liveMatches.length === 0) return [];
        const target = newestFirst(liveMatches)[0]!;
        const matchingThread =
          target.subscriptions.find((sub) =>
            options.trigger.threads.some(
              (thread) => normalizeThread(sub) === normalizeThread(thread)
            )
          ) ?? options.trigger.threads[0]!;
        const input: TicketInput = {
          triggerId: options.trigger.id,
          seq:
            target.inputs.reduce(
              (highest, item) => Math.max(highest, item.seq),
              0
            ) + 1,
          source: options.trigger.source,
          kind: options.trigger.kind,
          thread: matchingThread,
          at: options.trigger.at,
          attachedAt: options.attachedAt ?? new Date().toISOString(),
          ...(options.trigger.actor
            ? { actor: cloneActorRef(options.trigger.actor) }
            : {}),
          ...(options.trigger.human !== undefined
            ? { human: options.trigger.human }
            : {}),
          ...(options.trigger.admission
            ? { admission: options.trigger.admission }
            : {}),
          ...(options.trigger.addressed
            ? { addressed: options.trigger.addressed }
            : {}),
          ...(options.trigger.channel
            ? { channel: cloneChannelRef(options.trigger.channel) }
            : {}),
          ...(options.trigger.payload
            ? { payload: options.trigger.payload }
            : {}),
        };
        target.inputs.push(input);
        target.channels = mergeChannels(target.channels ?? [], [
          options.trigger.channel,
        ]);
        if (target.inputs.length > MAX_INPUTS_PER_TICKET) target.inputs.shift();
        await persist(target);
        return [target.id];
      });
    },
    async attachToTicket(options) {
      return serial(async () => {
        await ensureLoaded();
        const target = memory.get(options.ticketId);
        if (!target) return undefined;
        const triggers = [
          ...new Map(
            options.triggers.map((trigger) => [trigger.id, trigger])
          ).values(),
        ];
        const existing = new Set(target.inputs.map((input) => input.triggerId));
        const addedTriggerIds: string[] = [];
        let ticketChanged = false;
        for (const trigger of triggers) {
          const nextChannels = mergeChannels(target.channels ?? [], [
            trigger.channel,
          ]);
          if (nextChannels.length !== (target.channels ?? []).length) {
            target.channels = nextChannels;
            ticketChanged = true;
          }
          for (const thread of trigger.threads) {
            if (
              target.subscriptions.some(
                (subscription) =>
                  normalizeThread(subscription) === normalizeThread(thread)
              )
            ) {
              continue;
            }
            target.subscriptions.push(thread);
            ticketChanged = true;
          }
        }
        let seq = target.inputs.reduce(
          (highest, item) => Math.max(highest, item.seq),
          0
        );
        const attachedAt = options.attachedAt ?? new Date().toISOString();
        for (const trigger of triggers.sort((left, right) =>
          left.at.localeCompare(right.at)
        )) {
          if (existing.has(trigger.id)) continue;
          const input: TicketInput = {
            triggerId: trigger.id,
            seq: ++seq,
            source: trigger.source,
            kind: trigger.kind,
            thread: trigger.threads[0]!,
            at: trigger.at,
            attachedAt,
            ...(trigger.actor ? { actor: cloneActorRef(trigger.actor) } : {}),
            ...(trigger.human !== undefined ? { human: trigger.human } : {}),
            ...(trigger.admission ? { admission: trigger.admission } : {}),
            ...(trigger.addressed ? { addressed: trigger.addressed } : {}),
            ...(trigger.channel
              ? { channel: cloneChannelRef(trigger.channel) }
              : {}),
            ...(options.note ? { note: options.note } : {}),
            ...(trigger.payload ? { payload: trigger.payload } : {}),
          };
          target.inputs.push(input);
          existing.add(trigger.id);
          addedTriggerIds.push(trigger.id);
        }
        if (target.inputs.length > MAX_INPUTS_PER_TICKET) {
          target.inputs.splice(0, target.inputs.length - MAX_INPUTS_PER_TICKET);
        }
        if (addedTriggerIds.length > 0 || ticketChanged) {
          await persist(target);
        }
        return {
          ticket: target,
          addedTriggerIds,
          reused: addedTriggerIds.length === 0,
        };
      });
    },
    async unsubscribeThread(thread) {
      return serial(async () => {
        await ensureLoaded();
        const normalized = normalizeThread(thread);
        const removedFrom: string[] = [];
        for (const ticket of memory.values()) {
          const before = ticket.subscriptions.length;
          ticket.subscriptions = ticket.subscriptions.filter(
            (subscription) => normalizeThread(subscription) !== normalized
          );
          if (ticket.subscriptions.length === before) continue;
          removedFrom.push(ticket.id);
          await persist(ticket);
        }
        return removedFrom;
      });
    },
  };
}

function newestFirst(tickets: Ticket[]): Ticket[] {
  return tickets.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
}

function originsFor(triggers: readonly Trigger[]): TicketOrigin[] {
  return triggers.map((trigger) => ({
    triggerId: trigger.id,
    source: trigger.source,
    ...(trigger.actor ? { actor: cloneActorRef(trigger.actor) } : {}),
    ...(trigger.human !== undefined ? { human: trigger.human } : {}),
    ...(trigger.admission ? { admission: trigger.admission } : {}),
    ...(trigger.addressed ? { addressed: trigger.addressed } : {}),
    ...(trigger.channel ? { channel: cloneChannelRef(trigger.channel) } : {}),
  }));
}

function channelsFor(triggers: readonly Trigger[]): ChannelRef[] {
  return mergeChannels(
    [],
    triggers.map((trigger) => trigger.channel)
  );
}

function mergeChannels(
  existing: readonly ChannelRef[],
  incoming: readonly (ChannelRef | undefined)[]
): ChannelRef[] {
  const channels = new Map<string, ChannelRef>();
  for (const channel of [...existing, ...incoming]) {
    if (!channel) continue;
    const address = Object.entries(channel.address ?? {}).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    const key = JSON.stringify([channel.source, channel.thread, address]);
    if (!channels.has(key)) channels.set(key, cloneChannelRef(channel));
  }
  return [...channels.values()];
}

function cloneActorRef(actor: { source: string; id: string }): {
  source: string;
  id: string;
} {
  return { source: actor.source, id: actor.id };
}

function cloneChannelRef(channel: ChannelRef): ChannelRef {
  return {
    source: channel.source,
    thread: channel.thread,
    ...(channel.address ? { address: { ...channel.address } } : {}),
  };
}

function normalizeThread(thread: string): string {
  if (thread.startsWith("resource:")) return thread;
  if (thread.includes(":")) return `resource:${thread}`;
  return thread;
}
