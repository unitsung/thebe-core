import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Trigger } from "../sources/types.ts";

export const DEFAULT_CORRELATION_RETENTION = 1_000;

/**
 * Threads that share one Trigger. The first Trigger Thread is primary and owns Eval and routing.
 * This relation never routes work. It is durable context for the assessment and audit trail.
 */
export type Correlation = {
  /** Stable from the Trigger and its ordered Threads. */
  id: string;
  triggerId: string;
  source: string;
  at: string;
  primaryThread: string;
  /** Primary first, followed by every related Thread in Source order. */
  threads: string[];
};

export type CorrelationStore = {
  /** Records the relations derived from Triggers and returns them in input order. */
  record(triggers: readonly Trigger[]): Promise<Correlation[]>;
  forTrigger(triggerIds: readonly string[]): Promise<Correlation[]>;
  forThread(thread: string): Promise<Correlation[]>;
};

const ID_RE = /^[a-f0-9]{32}$/;

/** A relation exists only when a Trigger joins at least two distinct Threads. */
export function correlationFor(trigger: Trigger): Correlation | undefined {
  const threads = [...new Set(trigger.threads.filter(Boolean))];
  if (threads.length < 2) return undefined;
  const id = createHash("sha256")
    .update(
      JSON.stringify({
        triggerId: trigger.id,
        threads,
      })
    )
    .digest("hex")
    .slice(0, 32);
  return {
    id,
    triggerId: trigger.id,
    source: trigger.source,
    at: trigger.at,
    primaryThread: threads[0]!,
    threads,
  };
}

export function createCorrelationStore(options: {
  dir?: string;
  maxItems?: number;
}): CorrelationStore {
  const maxItems = options.maxItems ?? DEFAULT_CORRELATION_RETENTION;
  const memory = new Map<string, Correlation>();
  let loaded = !options.dir;
  let loading: Promise<void> | undefined;
  let queuedWrite: Promise<unknown> = Promise.resolve();
  let writeSeq = 0;

  async function load(): Promise<void> {
    if (!options.dir) return;
    let names: string[] = [];
    try {
      names = await readdir(options.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".tmp.json")) continue;
      try {
        const row = JSON.parse(
          await readFile(join(options.dir, name), "utf8")
        ) as Correlation;
        if (valid(row)) memory.set(row.id, row);
      } catch {
        // A damaged relation is skipped; its immutable Trigger remains available for recovery.
      }
    }
  }

  function ensureLoaded(): Promise<void> {
    if (loaded) return Promise.resolve();
    loading ??= load().finally(() => {
      loaded = true;
    });
    return loading;
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queuedWrite.then(operation, operation);
    queuedWrite = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function write(value: Correlation): Promise<void> {
    if (!options.dir) return;
    await mkdir(options.dir, { recursive: true });
    const temp = join(
      options.dir,
      `${value.id}.${process.pid}.${writeSeq++}.tmp.json`
    );
    await writeFile(temp, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temp, join(options.dir, `${value.id}.json`));
  }

  async function prune(): Promise<void> {
    if (memory.size <= maxItems) return;
    const oldest = [...memory.values()].sort((left, right) =>
      left.at < right.at ? -1 : left.at > right.at ? 1 : 0
    );
    for (const row of oldest.slice(0, memory.size - maxItems)) {
      memory.delete(row.id);
      if (options.dir) {
        await unlink(join(options.dir, `${row.id}.json`)).catch(() => {});
      }
    }
  }

  return {
    record(triggers) {
      return serialize(async () => {
        await ensureLoaded();
        const found: Correlation[] = [];
        for (const trigger of triggers) {
          const relation = correlationFor(trigger);
          if (!relation) continue;
          const existing = memory.get(relation.id);
          if (!existing) {
            memory.set(relation.id, relation);
            await write(relation);
            found.push(relation);
          } else {
            found.push(existing);
          }
        }
        await prune();
        return found;
      });
    },
    async forTrigger(triggerIds) {
      await ensureLoaded();
      const wanted = new Set(triggerIds);
      return [...memory.values()]
        .filter((row) => wanted.has(row.triggerId))
        .sort((left, right) =>
          left.at < right.at ? 1 : left.at > right.at ? -1 : 0
        );
    },
    async forThread(thread) {
      await ensureLoaded();
      return [...memory.values()]
        .filter((row) => row.threads.includes(thread))
        .sort((left, right) =>
          left.at < right.at ? 1 : left.at > right.at ? -1 : 0
        );
    },
  };
}

function valid(value: unknown): value is Correlation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<Correlation>;
  return (
    typeof row.id === "string" &&
    ID_RE.test(row.id) &&
    typeof row.triggerId === "string" &&
    typeof row.source === "string" &&
    typeof row.at === "string" &&
    typeof row.primaryThread === "string" &&
    Array.isArray(row.threads) &&
    row.threads.length >= 2 &&
    row.threads.every((thread) => typeof thread === "string") &&
    row.threads[0] === row.primaryThread
  );
}
