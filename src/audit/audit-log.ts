import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditRecord = {
  timestamp: string;
  method: string;
  parameterHash: string;
  responseBytes: number;
  budgetConsumed: number;
  redactionFired: boolean;
};

export function hashParameters(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex");
}

export function createAuditLog(path: string, now: () => Date) {
  return {
    async append(record: Omit<AuditRecord, "timestamp">): Promise<void> {
      const row: AuditRecord = {
        timestamp: now().toISOString(),
        ...record,
      };
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
    },
  };
}
