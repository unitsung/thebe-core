import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { TriggerRecord } from "./types.ts";

/** Records kept for de-duplication and for Activity. Older ones are dropped when the log is next rewritten. */
export const MAX_TRIGGER_RECORDS = 500;

export type SourceStore<Cursor> = {
  loadCursor(): Promise<Cursor | undefined>;
  /** Replaces the saved read position atomically. */
  saveCursor(cursor: Cursor): Promise<void>;
  loadRecords(): Promise<TriggerRecord[]>;
  /** Appends one immutable record. */
  appendRecord(record: TriggerRecord): Promise<void>;
};

/**
 * Persists one source: its read position (`<id>.cursor.json`) and the Triggers it produced with their
 * Gate outcomes (`<id>.triggers.jsonl`). Without a directory both live in memory.
 */
export function createSourceStore<Cursor>(options: {
  dir?: string;
  sourceId: string;
}): SourceStore<Cursor> {
  const { dir, sourceId } = options;
  let memoryCursor: Cursor | undefined;
  let memoryRecords: TriggerRecord[] = [];
  const cursorPath = dir ? join(dir, `${sourceId}.cursor.json`) : undefined;
  const logPath = dir ? join(dir, `${sourceId}.triggers.jsonl`) : undefined;

  return {
    async loadCursor() {
      if (!cursorPath) return memoryCursor;
      try {
        return JSON.parse(await readFile(cursorPath, "utf8")) as Cursor;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        // A cursor that cannot be read is treated like none: the source re-baselines, and the Gate's
        // de-duplication absorbs anything it re-reports.
        if (error instanceof SyntaxError) return undefined;
        throw error;
      }
    },
    async saveCursor(cursor) {
      if (!dir || !cursorPath) {
        memoryCursor = cursor;
        return;
      }
      await mkdir(dir, { recursive: true });
      const temporary = join(dir, `${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(cursor), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, cursorPath);
    },
    async loadRecords() {
      if (!logPath) return [...memoryRecords];
      let text: string;
      try {
        text = await readFile(logPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const records: TriggerRecord[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as TriggerRecord);
        } catch {
          // A torn last line from a crash; the record it held is re-read from the cursor.
        }
      }
      if (records.length <= MAX_TRIGGER_RECORDS) return records;
      const kept = records.slice(-MAX_TRIGGER_RECORDS);
      if (dir) {
        const temporary = join(dir, `${randomUUID()}.tmp`);
        await writeFile(
          temporary,
          kept.map((record) => JSON.stringify(record)).join("\n") + "\n",
          { encoding: "utf8", mode: 0o600 }
        );
        await rename(temporary, logPath);
      }
      return kept;
    },
    async appendRecord(record) {
      if (!dir || !logPath) {
        memoryRecords.push(record);
        if (memoryRecords.length > MAX_TRIGGER_RECORDS) {
          memoryRecords = memoryRecords.slice(-MAX_TRIGGER_RECORDS);
        }
        return;
      }
      await mkdir(dir, { recursive: true });
      await appendFile(logPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
  };
}
