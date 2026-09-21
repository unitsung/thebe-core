import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

export const AUDIT_RESULTS = ["ok", "error", "denied"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export const DEFAULT_AUDIT_LIMIT = 100;
export const MAX_AUDIT_LIMIT = 200;

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
  sessionId?: string;
  result?: AuditResult;
  durationMs?: number;
};

/** Product query for the append-only audit stream. Cursor is an opaque line offset. */
export type AuditQuery = {
  limit?: number;
  cursor?: number;
  sessionId?: string;
  method?: string;
  result?: AuditResult;
};

export type AuditPage = {
  entries: AuditRecord[];
  nextCursor?: string;
};

export function hashParameters(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args ?? {})).digest("hex");
}

/** Canonical JSON with sorted keys. Hash this after argument validation. */
export function canonicalJson(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (seen.has(value)) {
    return '"[Circular]"';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, seen)}`);
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
    async list(query: AuditQuery = {}): Promise<AuditPage> {
      const input = createReadStream(path, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      const limit = normalizeLimit(query.limit);
      const cursor = query.cursor ?? Number.MAX_SAFE_INTEGER;
      const matches: Array<{ line: number; record: AuditRecord }> = [];
      let line = 0;
      let hasOlder = false;
      try {
        for await (const raw of lines) {
          if (line < cursor) {
            const record = parseAuditRecord(raw);
            if (record && matchesQuery(record, query)) {
              if (matches.length >= limit) {
                matches.shift();
                hasOlder = true;
              }
              matches.push({ line, record });
            }
          }
          line += 1;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { entries: [] };
        }
        throw error;
      } finally {
        lines.close();
        input.destroy();
      }
      return {
        entries: matches.reverse().map((item) => item.record),
        ...(hasOlder && matches.at(-1)
          ? { nextCursor: String(matches.at(-1)?.line) }
          : {}),
      };
    },
  };
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    return DEFAULT_AUDIT_LIMIT;
  }
  return Math.min(value as number, MAX_AUDIT_LIMIT);
}

function matchesQuery(record: AuditRecord, query: AuditQuery): boolean {
  if (query.sessionId && record.sessionId !== query.sessionId) return false;
  if (query.method && record.method !== query.method) return false;
  if (query.result && record.result !== query.result) return false;
  return true;
}

/** Parse only the stable audit shape; malformed or future-incompatible rows are skipped. */
function parseAuditRecord(raw: string): AuditRecord | undefined {
  if (!raw.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.timestamp !== "string" ||
    typeof row.method !== "string" ||
    typeof row.parameterHash !== "string" ||
    typeof row.responseBytes !== "number" ||
    !Number.isFinite(row.responseBytes) ||
    typeof row.budgetConsumed !== "number" ||
    !Number.isFinite(row.budgetConsumed) ||
    typeof row.redactionFired !== "boolean"
  ) {
    return undefined;
  }
  if (
    row.result !== undefined &&
    (typeof row.result !== "string" ||
      !(AUDIT_RESULTS as readonly string[]).includes(row.result))
  ) {
    return undefined;
  }
  if (row.durationMs !== undefined &&
    (typeof row.durationMs !== "number" || !Number.isFinite(row.durationMs))) {
    return undefined;
  }

  const record: AuditRecord = {
    timestamp: row.timestamp,
    method: row.method,
    parameterHash: row.parameterHash,
    responseBytes: row.responseBytes,
    budgetConsumed: row.budgetConsumed,
    redactionFired: row.redactionFired,
  };
  for (const key of ["identity", "version", "source", "sessionId"] as const) {
    if (typeof row[key] === "string") record[key] = row[key];
  }
  if (typeof row.result === "string") record.result = row.result as AuditResult;
  if (typeof row.durationMs === "number") record.durationMs = row.durationMs;
  return record;
}
