import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Decision } from "./types.ts";

export const DEFAULT_DECISION_RETENTION = 500;

const ID_RE = /^[a-f0-9]{32}$/;

export type DecisionStore = {
  /** Stores a Decision once; the same id again returns the one already kept. */
  add(decision: Decision): Promise<Decision>;
  get(id: string): Promise<Decision | undefined>;
  list(query?: { thread?: string; limit?: number }): Promise<Decision[]>;
  /** Every Trigger id some Decision already covers, so a restart does not weigh the same one twice. */
  decidedTriggerIds(): Promise<Set<string>>;
};

export function createDecisionStore(options: {
  dir?: string;
  maxItems?: number;
}): DecisionStore {
  const maxItems = options.maxItems ?? DEFAULT_DECISION_RETENTION;
  const memory = new Map<string, Decision>();
  let loaded = !options.dir;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    if (!options.dir) return;
    let names: string[] = [];
    try {
      names = (await readdir(options.dir)).filter(
        (name) =>
          name.endsWith(".json") &&
          !name.endsWith(".tmp.json") &&
          name !== "policy.json"
      );
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const row = JSON.parse(
          await readFile(join(options.dir, name), "utf8")
        ) as Decision;
        if (row && ID_RE.test(row.id)) memory.set(row.id, row);
      } catch {
        // A damaged file is skipped, not fatal.
      }
    }
  }

  async function prune(): Promise<void> {
    if (memory.size <= maxItems) return;
    const oldest = [...memory.values()].sort((a, b) =>
      a.decidedAt < b.decidedAt ? -1 : a.decidedAt > b.decidedAt ? 1 : 0
    );
    for (const old of oldest.slice(0, memory.size - maxItems)) {
      memory.delete(old.id);
      if (options.dir)
        await unlink(join(options.dir, `${old.id}.json`)).catch(() => {});
    }
  }

  return {
    async add(decision) {
      await ensureLoaded();
      const existing = memory.get(decision.id);
      if (existing) return existing;
      memory.set(decision.id, decision);
      if (options.dir) {
        await mkdir(options.dir, { recursive: true });
        const temp = join(
          options.dir,
          `${decision.id}.${process.pid}.tmp.json`
        );
        await writeFile(temp, `${JSON.stringify(decision)}\n`, "utf8");
        await rename(temp, join(options.dir, `${decision.id}.json`));
      }
      await prune();
      return decision;
    },
    async get(id) {
      await ensureLoaded();
      return ID_RE.test(id) ? memory.get(id) : undefined;
    },
    async list(query) {
      await ensureLoaded();
      const rows = [...memory.values()]
        .filter((row) => !query?.thread || row.thread === query.thread)
        .sort((a, b) =>
          a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : 0
        );
      return query?.limit ? rows.slice(0, query.limit) : rows;
    },
    async decidedTriggerIds() {
      await ensureLoaded();
      const ids = new Set<string>();
      for (const row of memory.values())
        for (const id of row.triggerIds) ids.add(id);
      return ids;
    },
  };
}
