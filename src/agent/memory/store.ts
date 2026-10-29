import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  emptyMemory,
  MEMORY_LIMIT_BYTES,
  MEMORY_TARGETS,
  normalizeMemoryEntry,
  type MemorySnapshot,
} from "./memory.ts";

export type AgentMemoryStore = {
  load(): MemorySnapshot;
  save(snapshot: MemorySnapshot): void | Promise<void>;
};

/** Thebe Memory as a JSON file in the config directory, written whole through a rename. */
export function createJsonMemoryStore(path: string): AgentMemoryStore {
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        const snapshot = emptyMemory();
        if (typeof parsed !== "object" || parsed === null) return snapshot;
        for (const target of MEMORY_TARGETS) {
          const raw = (parsed as Record<string, unknown>)[target];
          if (!Array.isArray(raw)) continue;
          // A file edited by hand is kept as far as it fits instead of being dropped.
          const entries: string[] = [];
          let used = 0;
          for (const item of raw) {
            if (typeof item !== "string") continue;
            const entry = normalizeMemoryEntry(item);
            if (!entry || entries.includes(entry)) continue;
            const cost = Buffer.byteLength(`- ${entry}\n`, "utf8");
            if (used + cost > MEMORY_LIMIT_BYTES[target] + 1) break;
            entries.push(entry);
            used += cost;
          }
          snapshot[target] = entries;
        }
        return snapshot;
      } catch {
        return emptyMemory();
      }
    },
    save(snapshot) {
      // Memory is written whole; replacing a file we cannot parse would drop
      // every entry the owner had.
      assertMemoryFileIsReplaceable(path);
      mkdirSync(dirname(path), { recursive: true });
      const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
      writeFileSync(temporaryPath, `${JSON.stringify({ user: snapshot.user, notes: snapshot.notes }, null, 2)}\n`, "utf8");
      renameSync(temporaryPath, path);
    },
  };
}

function assertMemoryFileIsReplaceable(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    JSON.parse(text);
  } catch {
    throw new Error(
      `Refusing to overwrite ${path}: the file is not valid JSON`
    );
  }
}
