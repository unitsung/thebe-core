import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ActionReceipt } from "../action/types.ts";
import { CONTAINER_RESTART_ACTION_ID } from "../capabilities/containers.ts";
import type { DiagnosisResult } from "../diagnosis/types.ts";
import {
  activityApprovalFromDiagnosis,
  activityFromDiagnosis,
  activityFromReceipt,
  assignActivityGroups,
  hasRestartRecommendation,
  idempotencyIndexKey,
  isPendingApproval,
  type ActivityGroup,
  type ActivityRecord,
} from "./types.ts";

export const DEFAULT_ACTIVITY_RETENTION = 50;

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export type ActivityStore = {
  upsertFromReceipt(receipt: ActionReceipt): Promise<ActivityRecord>;
  upsertFromDiagnosis(
    result: DiagnosisResult
  ): Promise<ActivityRecord | undefined>;
  findPendingForDiagnosis(
    diagnosisRunId: string
  ): Promise<ActivityRecord | undefined>;
  removePending(id: string): Promise<boolean>;
  get(id: string): Promise<ActivityRecord | undefined>;
  getByIdempotency(key: string): Promise<ActivityRecord | undefined>;
  list(group?: ActivityGroup): Promise<ActivityRecord[]>;
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
        (name) => name.endsWith(".json") && !name.endsWith(".tmp.json")
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

  async function drop(id: string): Promise<void> {
    const existing = memory.get(id);
    if (existing) {
      memory.delete(id);
      byIdempotency.delete(idempotencyIndexKey(existing));
    }
    if (!options.dir) return;
    try {
      await unlink(join(options.dir, `${id}.json`));
    } catch {
      // Missing file is already gone.
    }
  }

  async function prune(): Promise<void> {
    if (memory.size <= maxItems) return;
    const ordered = [...memory.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
    );
    const extra = ordered.slice(0, Math.max(0, ordered.length - maxItems));
    for (const item of extra) {
      await drop(item.id);
    }
  }

  function pendingForDiagnosis(
    diagnosisRunId: string
  ): ActivityRecord | undefined {
    return [...memory.values()].find((item) => {
      if (!isPendingApproval(item)) return false;
      return (
        item.diagnosisRunId === diagnosisRunId || item.id === diagnosisRunId
      );
    });
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
        if (existing && existing.action) return grouped(existing);
      }
      const prior =
        (receipt.diagnosisRunId
          ? pendingForDiagnosis(receipt.diagnosisRunId)
          : undefined) ?? memory.get(receipt.receiptId);
      const stamp = options.now().toISOString();
      const aligned: ActionReceipt = {
        ...receipt,
        receiptId: prior?.id ?? receipt.receiptId,
      };
      if (prior) {
        byIdempotency.delete(idempotencyIndexKey(prior));
      }
      const record = activityFromReceipt(
        aligned,
        { createdAt: prior?.createdAt ?? stamp, updatedAt: stamp },
        prior
      );
      memory.set(record.id, record);
      byIdempotency.set(key, record.id);
      await persist(record);
      return grouped(record);
    },
    async upsertFromDiagnosis(
      result: DiagnosisResult
    ): Promise<ActivityRecord | undefined> {
      await ensureLoaded();
      const diagnosisKey = idempotencyIndexKey({
        actionId: result.actionId,
        resource: result.resource,
        idempotencyKey: `diagnose:${result.resource.id}:${result.runId}`,
      });
      const existingDiagnosisId =
        byIdempotency.get(diagnosisKey) ??
        (memory.has(result.runId) ? result.runId : undefined);
      if (!hasRestartRecommendation(result)) {
        for (const item of memory.values()) {
          if (
            isPendingApproval(item) &&
            item.resource.id === result.resource.id &&
            item.actionId === CONTAINER_RESTART_ACTION_ID
          ) {
            await drop(item.id);
          }
        }
        const prior = existingDiagnosisId
          ? memory.get(existingDiagnosisId)
          : undefined;
        const stamp = options.now().toISOString();
        const record = activityFromDiagnosis(result, {
          createdAt: prior?.createdAt ?? stamp,
          updatedAt: stamp,
        });
        memory.set(record.id, record);
        byIdempotency.set(idempotencyIndexKey(record), record.id);
        await persist(record);
        return grouped(record);
      }
      if (existingDiagnosisId) {
        await drop(existingDiagnosisId);
      }
      for (const item of memory.values()) {
        if (
          isPendingApproval(item) &&
          item.resource.id === result.resource.id &&
          item.actionId === CONTAINER_RESTART_ACTION_ID
        ) {
          await drop(item.id);
        }
      }
      const stamp = options.now().toISOString();
      const record = activityApprovalFromDiagnosis(
        result,
        {
          createdAt: stamp,
          updatedAt: stamp,
        },
        randomUUID()
      );
      memory.set(record.id, record);
      byIdempotency.set(idempotencyIndexKey(record), record.id);
      await persist(record);
      return grouped(record);
    },
    async findPendingForDiagnosis(
      diagnosisRunId: string
    ): Promise<ActivityRecord | undefined> {
      await ensureLoaded();
      const record = pendingForDiagnosis(diagnosisRunId);
      return record ? grouped(record) : undefined;
    },
    async removePending(id: string): Promise<boolean> {
      await ensureLoaded();
      const record =
        memory.get(id) ??
        [...memory.values()].find(
          (item) => isPendingApproval(item) && item.diagnosisRunId === id
        );
      if (!record || !isPendingApproval(record)) return false;
      await drop(record.id);
      return true;
    },
    async get(id: string): Promise<ActivityRecord | undefined> {
      await ensureLoaded();
      const record = memory.get(id);
      if (!record) return undefined;
      return grouped(record);
    },
    async getByIdempotency(key: string): Promise<ActivityRecord | undefined> {
      await ensureLoaded();
      const id = byIdempotency.get(key);
      const record = id ? memory.get(id) : undefined;
      return record ? grouped(record) : undefined;
    },
    async list(group?: ActivityGroup): Promise<ActivityRecord[]> {
      await ensureLoaded();
      const rows = assignActivityGroups(
        [...memory.values()].sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
        )
      );
      return group ? rows.filter((item) => item.group === group) : rows;
    },
  };

  function grouped(record: ActivityRecord): ActivityRecord {
    return (
      assignActivityGroups([...memory.values()]).find(
        (item) => item.id === record.id
      ) ?? record
    );
  }
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
    if (typeof parsed.id !== "string" || !ID_RE.test(parsed.id))
      return undefined;
    if (
      parsed.kind !== "container.restart" &&
      parsed.kind !== "container.diagnose"
    ) {
      return undefined;
    }
    if (
      parsed.kind === "container.restart" &&
      parsed.status !== "pending" &&
      typeof parsed.receiptId !== "string"
    ) {
      return undefined;
    }
    if (typeof parsed.idempotencyKey !== "string") return undefined;
    if (!parsed.resource || typeof parsed.resource !== "object")
      return undefined;
    if (typeof parsed.status !== "string") return undefined;
    if (typeof parsed.createdAt !== "string") return undefined;
    return parsed as ActivityRecord;
  } catch {
    return undefined;
  }
}
