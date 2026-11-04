import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Decision } from "./types.ts";

/** Decisions kept, like the Trigger records they belong to. */
export const MAX_DECISIONS = 500;

export type DecisionStore = {
  load(): Promise<Decision[]>;
  /** Appends one immutable decision. */
  append(decision: Decision): Promise<void>;
};

/** `<dir>/decisions.jsonl`; without a directory the decisions live in memory. */
export function createDecisionStore(options: { dir?: string }): DecisionStore {
  const { dir } = options;
  const path = dir ? join(dir, "decisions.jsonl") : undefined;
  let memory: Decision[] = [];
  return {
    async load() {
      if (!path || !dir) return [...memory];
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const decisions: Decision[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          decisions.push(JSON.parse(line) as Decision);
        } catch {
          // A torn last line from a crash: that Trigger is settled as interrupted on the next start.
        }
      }
      if (decisions.length <= MAX_DECISIONS) return decisions;
      const kept = decisions.slice(-MAX_DECISIONS);
      const temporary = join(dir, `${randomUUID()}.tmp`);
      await writeFile(
        temporary,
        kept.map((decision) => JSON.stringify(decision)).join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 }
      );
      await rename(temporary, path);
      return kept;
    },
    async append(decision) {
      if (!path || !dir) {
        memory.push(decision);
        if (memory.length > MAX_DECISIONS) {
          memory = memory.slice(-MAX_DECISIONS);
        }
        return;
      }
      await mkdir(dir, { recursive: true });
      await appendFile(path, `${JSON.stringify(decision)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
  };
}
