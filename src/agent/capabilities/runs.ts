import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CAPABILITY_RUN_STATUS_FAILED,
  CAPABILITY_RUN_STATUSES,
  type CapabilityRun,
  type CapabilityRunStatus,
} from "./invoke.ts";

export const DEFAULT_CAPABILITY_RUN_RETENTION = 100;
export const CAPABILITY_RUN_INTERRUPTED_ERROR =
  "Capability run interrupted when Core restarted.";

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

type StoredCapabilityRun = {
  ownerId: string;
  run: CapabilityRun;
};

export type CapabilityRunStore = {
  save(run: CapabilityRun): Promise<void>;
  get(runId: string): Promise<CapabilityRun | undefined>;
  list(): Promise<CapabilityRun[]>;
};

/**
 * Durable snapshots for product capability runs.
 *
 * The owner id makes process boundaries explicit: terminal runs are restored,
 * while queued/running snapshots belonging to an older agent instance are
 * recovered as failed because their in-process executor no longer exists.
 */
export function createCapabilityRunStore(options: {
  dir?: string;
  now: () => Date;
  ownerId?: string;
  maxItems?: number;
}): CapabilityRunStore {
  const ownerId = options.ownerId ?? randomUUID();
  const maxItems = options.maxItems ?? DEFAULT_CAPABILITY_RUN_RETENTION;
  const memory = new Map<string, CapabilityRun>();
  let loaded = !options.dir;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    if (!options.dir) return;

    let names: string[] = [];
    try {
      names = (await readdir(options.dir)).filter(
        (name) => name.endsWith(".json") && !name.endsWith(".tmp.json"),
      );
    } catch {
      return;
    }

    const interrupted: CapabilityRun[] = [];
    for (const name of names) {
      const stored = await readStoredRun(join(options.dir, name));
      if (!stored) continue;
      let run = stored.run;
      if (
        isActive(run.status) &&
        stored.ownerId !== ownerId
      ) {
        const stamp = options.now().toISOString();
        run = {
          ...run,
          status: CAPABILITY_RUN_STATUS_FAILED,
          error: CAPABILITY_RUN_INTERRUPTED_ERROR,
          finishedAt: stamp,
          updatedAt: stamp,
        };
        interrupted.push(run);
      }
      memory.set(run.runId, run);
    }

    for (const run of interrupted) {
      await persist(run);
    }
  }

  async function persist(run: CapabilityRun): Promise<void> {
    if (!options.dir) return;
    await mkdir(options.dir, { recursive: true });
    const target = join(options.dir, `${run.runId}.json`);
    const temp = join(
      options.dir,
      `${run.runId}.${process.pid}.${randomUUID()}.tmp.json`,
    );
    const stored: StoredCapabilityRun = { ownerId, run };
    await writeFile(temp, `${JSON.stringify(stored)}\n`, "utf8");
    await rename(temp, target);
    await prune();
  }

  async function drop(runId: string): Promise<void> {
    memory.delete(runId);
    if (!options.dir) return;
    try {
      await unlink(join(options.dir, `${runId}.json`));
    } catch {
      // Missing files are already gone.
    }
  }

  async function prune(): Promise<void> {
    if (memory.size <= maxItems) return;
    const candidates = [...memory.values()]
      .filter((run) => !isActive(run.status))
      .sort((a, b) => compareTimestamp(a.createdAt, b.createdAt));
    const extra = candidates.slice(0, Math.max(0, memory.size - maxItems));
    for (const run of extra) {
      await drop(run.runId);
    }
  }

  return {
    async save(run: CapabilityRun): Promise<void> {
      assertValidRun(run);
      await ensureLoaded();
      memory.set(run.runId, run);
      await persist(run);
    },
    async get(runId: string): Promise<CapabilityRun | undefined> {
      assertValidRunId(runId);
      await ensureLoaded();
      const run = memory.get(runId);
      return run ? { ...run } : undefined;
    },
    async list(): Promise<CapabilityRun[]> {
      await ensureLoaded();
      return [...memory.values()]
        .sort((a, b) => compareTimestamp(b.updatedAt ?? b.createdAt, a.updatedAt ?? a.createdAt))
        .map((run) => ({ ...run }));
    },
  };
}

function isActive(status: CapabilityRunStatus): boolean {
  return status === "queued" || status === "running";
}

function compareTimestamp(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertValidRunId(runId: string): void {
  if (!ID_RE.test(runId)) {
    throw new Error(`invalid capability run id: ${runId}`);
  }
}

function assertValidRun(run: CapabilityRun): void {
  assertValidRunId(run.runId);
  if (typeof run.capabilityId !== "string" || run.capabilityId.length === 0) {
    throw new Error("capability run capabilityId is required");
  }
  if (!CAPABILITY_RUN_STATUSES.includes(run.status)) {
    throw new Error(`invalid capability run status: ${run.status}`);
  }
  if (typeof run.createdAt !== "string") {
    throw new Error("capability run createdAt is required");
  }
  if (run.updatedAt !== undefined && typeof run.updatedAt !== "string") {
    throw new Error("capability run updatedAt must be a string");
  }
  if (run.finishedAt !== undefined && typeof run.finishedAt !== "string") {
    throw new Error("capability run finishedAt must be a string");
  }
  if (run.error !== undefined && typeof run.error !== "string") {
    throw new Error("capability run error must be a string");
  }
  if (
    run.resource !== undefined &&
    (typeof run.resource !== "object" || run.resource === null || Array.isArray(run.resource))
  ) {
    throw new Error("capability run resource must be an object");
  }
}

async function readStoredRun(path: string): Promise<StoredCapabilityRun | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const stored = isRecord(parsed) && isRecord(parsed.run)
      ? {
          ownerId: typeof parsed.ownerId === "string" ? parsed.ownerId : "",
          run: parsed.run,
        }
      : { ownerId: "", run: parsed };
    if (!isRecord(stored.run)) return undefined;
    const run = stored.run as Partial<CapabilityRun>;
    if (
      typeof run.runId !== "string" ||
      typeof run.capabilityId !== "string" ||
      typeof run.status !== "string" ||
      typeof run.createdAt !== "string" ||
      !CAPABILITY_RUN_STATUSES.includes(run.status as CapabilityRunStatus)
    ) {
      return undefined;
    }
    const normalized = run as CapabilityRun;
    assertValidRun(normalized);
    return { ownerId: stored.ownerId, run: normalized };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
