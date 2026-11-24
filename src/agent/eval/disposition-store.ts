import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { key } from "../tickets/ids.ts";

export const DEFAULT_EVAL_DISPOSITION_RETENTION = 1000;

const ID_RE = /^[a-f0-9]{32}$/;

export type DecisionDismissal = {
  id: string;
  kind: "decision.dismissed";
  decisionId: string;
  at: string;
  reason?: string;
};

export type TriggerRequeue = {
  id: string;
  kind: "trigger.requeued";
  triggerId: string;
  at: string;
  requester: string;
};

export type EvalDisposition = DecisionDismissal | TriggerRequeue;

export type EvalDispositionStore = {
  dismissDecision(input: {
    decisionId: string;
    at: string;
    reason?: string;
  }): Promise<DecisionDismissal>;
  requeueTrigger(input: {
    triggerId: string;
    at: string;
    requester: string;
  }): Promise<TriggerRequeue>;
  getDecisionDismissal(
    decisionId: string
  ): Promise<DecisionDismissal | undefined>;
  listDecisionDismissals(): Promise<DecisionDismissal[]>;
  listTriggerRequeues(query?: {
    triggerId?: string;
  }): Promise<TriggerRequeue[]>;
};

/**
 * Human dispositions live beside Decisions, never inside them. A dismissal or requeue changes what a
 * person sees or asks Eval to do next; it never rewrites what the Assessment originally decided.
 */
export function createEvalDispositionStore(options: {
  dir?: string;
  maxItems?: number;
}): EvalDispositionStore {
  const maxItems = options.maxItems ?? DEFAULT_EVAL_DISPOSITION_RETENTION;
  const memory = new Map<string, EvalDisposition>();
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
        const row = JSON.parse(
          await readFile(join(options.dir, name), "utf8")
        ) as EvalDisposition;
        if (
          row &&
          ID_RE.test(row.id) &&
          (row.kind === "decision.dismissed" || row.kind === "trigger.requeued")
        ) {
          memory.set(row.id, row);
        }
      } catch {
        // A damaged disposition is skipped, not fatal.
      }
    }
  }

  async function add(disposition: EvalDisposition): Promise<EvalDisposition> {
    await ensureLoaded();
    const existing = memory.get(disposition.id);
    if (existing) return existing;
    memory.set(disposition.id, disposition);
    if (options.dir) {
      await mkdir(options.dir, { recursive: true });
      const temp = join(
        options.dir,
        `${disposition.id}.${process.pid}.tmp.json`
      );
      await writeFile(temp, `${JSON.stringify(disposition)}\n`, "utf8");
      await rename(temp, join(options.dir, `${disposition.id}.json`));
    }
    await prune();
    return disposition;
  }

  async function prune(): Promise<void> {
    if (memory.size <= maxItems) return;
    const oldest = [...memory.values()].sort((left, right) =>
      left.at < right.at ? -1 : left.at > right.at ? 1 : 0
    );
    for (const old of oldest.slice(0, memory.size - maxItems)) {
      memory.delete(old.id);
      if (options.dir)
        await unlink(join(options.dir, `${old.id}.json`)).catch(() => {});
    }
  }

  return {
    dismissDecision(input) {
      return serial(async () => {
        const dismissal: DecisionDismissal = {
          id: key("disposition", "decision-dismissed", input.decisionId),
          kind: "decision.dismissed",
          decisionId: input.decisionId,
          at: input.at,
          ...(input.reason ? { reason: input.reason } : {}),
        };
        return (await add(dismissal)) as DecisionDismissal;
      });
    },
    requeueTrigger(input) {
      return serial(async () => {
        const requeue: TriggerRequeue = {
          id: key(
            "disposition",
            "trigger-requeued",
            input.triggerId,
            input.at,
            randomUUID()
          ),
          kind: "trigger.requeued",
          triggerId: input.triggerId,
          at: input.at,
          requester: input.requester,
        };
        return (await add(requeue)) as TriggerRequeue;
      });
    },
    async getDecisionDismissal(decisionId) {
      await ensureLoaded();
      const row = memory.get(
        key("disposition", "decision-dismissed", decisionId)
      );
      return row?.kind === "decision.dismissed" ? row : undefined;
    },
    async listDecisionDismissals() {
      await ensureLoaded();
      return [...memory.values()]
        .filter(
          (row): row is DecisionDismissal => row.kind === "decision.dismissed"
        )
        .sort((left, right) => right.at.localeCompare(left.at));
    },
    async listTriggerRequeues(query) {
      await ensureLoaded();
      return [...memory.values()]
        .filter(
          (row): row is TriggerRequeue =>
            row.kind === "trigger.requeued" &&
            (!query?.triggerId || row.triggerId === query.triggerId)
        )
        .sort((left, right) => left.at.localeCompare(right.at));
    },
  };
}
