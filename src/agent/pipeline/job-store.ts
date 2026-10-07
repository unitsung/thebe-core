import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Job, JobStore } from "./job-runner.ts";

/** Jobs are small and few; one atomically replaced JSON file is enough. */
export function createFileJobStore(path: string): JobStore {
  return {
    load() {
      try {
        const data: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(data) ? (data as Job[]).filter(job => job && typeof job.id === "string" && typeof job.hash === "string") : [];
      } catch {
        return [];
      }
    },
    save(jobs) {
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
