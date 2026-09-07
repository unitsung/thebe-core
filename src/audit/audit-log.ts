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
  identity?: string;
  version?: string;
  source?: string;
};

export function hashParameters(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args ?? {})).digest("hex");
}

/** Canonical JSON with sorted keys. Hash this after argument validation. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
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
