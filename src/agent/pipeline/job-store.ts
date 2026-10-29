import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Job, JobStore } from "./job-runner.ts";

/** Jobs are small and few; one atomically replaced JSON file is enough. */
export function createFileJobStore(path: string): JobStore {
  return {
    load() {
      try {
        const data: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(data)
          ? (data as Job[]).filter(
              (job) =>
                job &&
                typeof job.id === "string" &&
                typeof job.stage === "string"
            )
          : [];
      } catch {
        return [];
      }
    },
    save(jobs) {
      // Jobs are rewritten whole. If the old file cannot be parsed, writing
      // here would silently drop every durable job it held.
      if (!isReplaceable(path)) {
        console.warn(`[thebe] leaving unreadable job store ${path} in place`);
        return;
      }
      try {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(jobs), { mode: 0o600 });
        renameSync(temporary, path);
      } catch {
        // A full disk must not break the running job; it just will not survive a restart.
      }
    },
  };
}

function isReplaceable(path: string): boolean {
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
