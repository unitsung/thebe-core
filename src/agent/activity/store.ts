import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionReceipt } from "../action/types.ts";
import {
  activityFromReceipt,
  idempotencyIndexKey,
  type ActivityRecord,
} from "./types.ts";

export const DEFAULT_ACTIVITY_RETENTION = 50;

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export type ActivityStore = {
  upsertFromReceipt(receipt: ActionReceipt): Promise<ActivityRecord>;
  get(id: string): Promise<ActivityRecord | undefined>;
  getByIdempotency(key: string): Promise<ActivityRecord | undefined>;
  list(): Promise<ActivityRecord[]>;
};

export function createActivityStore(options: {
  dir?: string;
  now: () => Date;
  maxItems?: number;
}): ActivityStore {
  const maxItems = options.maxItems ?? DEFAULT_ACTIVITY_RETENTION;
  const memory = new Map<string, ActivityRecord>();
  const byIdempotency = new Map<string, string>();
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
    for (const name of names) {
      const record = await readFileSafe(join(options.dir, name));
      if (!record) continue;
      memory.set(record.id, record);
      byIdempotency.set(idempotencyIndexKey(record), record.id);
    }
  }

  async function persist(record: ActivityRecord): Promise<void> {
    if (!options.dir) return;
    await mkdir(options.dir, { recursive: true });
    const target = join(options.dir, `${record.id}.json`);
    const temp = join(options.dir, `${record.id}.${process.pid}.tmp.json`);
    await writeFile(temp, `${JSON.stringify(record)}\n`, "utf8");
    await rename(temp, target);
    await prune();
  }

  async function prune(): Promise<void> {
    if (memory.size <= maxItems) return;
    const ordered = [...memory.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    const extra = ordered.slice(0, Math.max(0, ordered.length - maxItems));
    for (const item of extra) {
      memory.delete(item.id);
      byIdempotency.delete(idempotencyIndexKey(item));
      if (!options.dir) continue;
      try {
        await unlink(join(options.dir, `${item.id}.json`));
      } catch {
        // Missing file is already gone.
      }
    }
  }

  return {
    async upsertFromReceipt(receipt: ActionReceipt): Promise<ActivityRecord> {
      await ensureLoaded();
      const key = idempotencyIndexKey({
        actionId: receipt.actionId,
        resource: receipt.resource,
        idempotencyKey: receipt.idempotencyKey,
      });
      const existingId = byIdempotency.get(key);
      if (existingId) {
        const existing = memory.get(existingId);
        if (existing) return existing;
      }
      const stamp = options.now().toISOString();
      const record = activityFromReceipt(receipt, { createdAt: stamp, updatedAt: stamp });
      memory.set(record.id, record);
      byIdempotency.set(key, record.id);
      await persist(record);
      return record;
    },
    async get(id: string): Promise<ActivityRecord | undefined> {
      await ensureLoaded();
      return memory.get(id);
    },
    async getByIdempotency(key: string): Promise<ActivityRecord | undefined> {
      await ensureLoaded();
      const id = byIdempotency.get(key);
      return id ? memory.get(id) : undefined;
    },
    async list(): Promise<ActivityRecord[]> {
      await ensureLoaded();
      return [...memory.values()].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
    },
  };
}

async function readFileSafe(path: string): Promise<ActivityRecord | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Partial<ActivityRecord>;
    if (typeof parsed.id !== "string" || !ID_RE.test(parsed.id)) return undefined;
    if (parsed.kind !== "container.restart") return undefined;
    if (typeof parsed.receiptId !== "string") return undefined;
    if (typeof parsed.idempotencyKey !== "string") return undefined;
    if (!parsed.resource || typeof parsed.resource !== "object") return undefined;
    if (typeof parsed.status !== "string") return undefined;
    if (typeof parsed.createdAt !== "string") return undefined;
    return parsed as ActivityRecord;
  } catch {
    return undefined;
  }
}
