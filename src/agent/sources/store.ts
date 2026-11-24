import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Trigger } from "./types.ts";

export const DEFAULT_TRIGGER_RETENTION = 1000;

const ID_RE = /^[a-f0-9]{32}$/;

export type TriggerStore = {
  /** Stores each Trigger once; returns only the ones that were new. */
  add(triggers: readonly Trigger[]): Promise<Trigger[]>;
  get(id: string): Promise<Trigger | undefined>;
  list(query?: { thread?: string; limit?: number }): Promise<Trigger[]>;
  cursor(source: string): Promise<string | undefined>;
  setCursor(source: string, cursor: string): Promise<void>;
};

export function createTriggerStore(options: {
  dir?: string;
  maxItems?: number;
}): TriggerStore {
  const maxItems = options.maxItems ?? DEFAULT_TRIGGER_RETENTION;
  const memory = new Map<string, Trigger>();
  const cursors = new Map<string, string>();
  let loaded = !options.dir;
  let loading: Promise<void> | undefined;
  let queuedWrite: Promise<unknown> = Promise.resolve();
  let writeSeq = 0;

  async function load(): Promise<void> {
    const dir = options.dir;
    if (!dir) return;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        if (name === "cursors.json") {
          const saved = JSON.parse(
            await readFile(join(dir, name), "utf8")
          ) as Record<string, string>;
          for (const [source, value] of Object.entries(saved))
            cursors.set(source, value);
        } else if (name.endsWith(".json") && !name.endsWith(".tmp.json")) {
          const trigger = JSON.parse(
            await readFile(join(dir, name), "utf8")
          ) as Trigger;
          if (trigger && ID_RE.test(trigger.id))
            memory.set(trigger.id, trigger);
        }
      } catch {
        // A damaged file is skipped, not fatal.
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

  /** Runs mutations one at a time so a cursor snapshot cannot overwrite another Source's entry. */
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queuedWrite.then(operation, operation);
    queuedWrite = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function write(name: string, value: unknown): Promise<void> {
    if (!options.dir) return;
    await mkdir(options.dir, { recursive: true });
    const temp = join(
      options.dir,
      `${name}.${process.pid}.${writeSeq++}.tmp.json`
    );
    await writeFile(temp, `${JSON.stringify(value)}\n`, "utf8");
    await rename(temp, join(options.dir, `${name}.json`));
  }

  async function prune(): Promise<void> {
    if (memory.size <= maxItems) return;
    const oldest = [...memory.values()].sort((a, b) =>
      a.at < b.at ? -1 : a.at > b.at ? 1 : 0
    );
    for (const old of oldest.slice(0, memory.size - maxItems)) {
      memory.delete(old.id);
      if (options.dir)
        await unlink(join(options.dir, `${old.id}.json`)).catch(() => {});
    }
  }

  return {
    add(triggers) {
      return serialize(async () => {
        await ensureLoaded();
        const fresh: Trigger[] = [];
        for (const trigger of triggers) {
          if (memory.has(trigger.id)) continue;
          memory.set(trigger.id, trigger);
          await write(trigger.id, trigger);
          fresh.push(trigger);
        }
        await prune();
        return fresh;
      });
    },
    async get(id) {
      await ensureLoaded();
      return ID_RE.test(id) ? memory.get(id) : undefined;
    },
    async list(query) {
      await ensureLoaded();
      const rows = [...memory.values()]
        .filter((t) => !query?.thread || t.threads.includes(query.thread))
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      return query?.limit ? rows.slice(0, query.limit) : rows;
    },
    async cursor(source) {
      await ensureLoaded();
      return cursors.get(source);
    },
    setCursor(source, cursor) {
      return serialize(async () => {
        await ensureLoaded();
        cursors.set(source, cursor);
        await write("cursors", Object.fromEntries(cursors));
      });
    },
  };
}
