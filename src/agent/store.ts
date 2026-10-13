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
import type { GoalRun, SubagentRun, SubagentRunStatus } from "./types.ts";

export type StoredGoalEvent = {
  event:
    | {
        type: "goal_started";
        goal: string;
        criteria?: string[];
        maxIterations: number;
      }
    | { type: "goal_iteration"; iteration: number; maxIterations: number }
    | {
        type: "goal_reviewed";
        iteration: number;
        complete: boolean;
        score: number;
        critique: string;
        remainingTasks?: string[];
      }
    | {
        type: "goal_completed";
        status: "completed" | "max_iterations" | "cancelled" | "failed";
        totalIterations: number;
        summary: string;
      }
    | {
        type: "goal_subagent_update";
        iteration: number;
        role: "worker" | "reviewer";
        run: { runId: string; profileName: string; status: SubagentRunStatus };
      }
    | {
        type: "goal_status";
        status: "running" | "pausing" | "paused" | "cancelled" | "failed";
        message?: string;
      };
  at: string;
};

export type AgentSessionMeta = {
  thebeSessionId: string;
  runtimeId: string;
  runtimeSessionId: string;
  title?: string;
  createdAt?: string;
  /** Last metadata write (create, patch, remember, share). */
  updatedAt?: string;
  /** Last activity of any kind, including prompt runs. */
  lastActiveAt?: string;
  parentThebeSessionId?: string;
  selectedContext?: {
    host?: string;
    environment?: string;
    service?: string;
    hostId?: string;
    environmentId?: string;
    serviceIds?: string[];
  };
  labels?: Record<string, string>;
  shareMetadata?: Record<string, unknown>;
  rememberedPermissions?: Record<string, "allow" | "deny">;
  builtinTools?: string[];
  firstMessage?: string;
  messageCount?: number;
  /** Current Pi/fake tree leaf. Used with `branch_in_place` forks. */
  leafId?: string;
  /** Hidden from `GET /v1/session`; listed under parent `/children`. */
  inPlace?: boolean;
  /** Latest background/manual task summary, when one has been generated. */
  lastSummary?: string;
  lastSummaryAt?: string;
  /** Bounded Goal control-plane state for restoring the Tasks view. */
  goalRun?: GoalRun;
  /** Bounded Goal lifecycle events retained for the product log. */
  goalEvents?: StoredGoalEvent[];
  /** Bounded child-run snapshots retained for later inspection and recovery. */
  subagentRuns?: SubagentRun[];
};

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function assertValidSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`invalid session id: ${id}`);
  }
}

const FORBIDDEN_KEYS = [
  "transcript",
  "messages",
  "compaction",
  "refresh_token",
  "refreshToken",
  "oauth",
  "branch",
  "branches",
] as const;

export function assertMetadataOnly(record: Record<string, unknown>): void {
  for (const key of FORBIDDEN_KEYS) {
    if (key in record) {
      throw new Error(`AgentStore forbids persistence key: ${key}`);
    }
  }
}

export function createAgentStore(dir?: string) {
  async function save(meta: AgentSessionMeta): Promise<void> {
    assertValidSessionId(meta.thebeSessionId);
    assertMetadataOnly(meta as unknown as Record<string, unknown>);
    if (!dir) {
      return;
    }
    await mkdir(dir, { recursive: true });
    // Write to a unique temp file and rename over the target: a concurrent
    // load/list sees either the previous file or the complete new one, never a
    // half-written (empty) file. The `.tmp` suffix keeps it out of `list()`.
    const target = join(dir, `${meta.thebeSessionId}.json`);
    const temp = join(dir, `.${meta.thebeSessionId}.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(meta), "utf8");
    await rename(temp, target);
  }

  async function load(thebeSessionId: string): Promise<AgentSessionMeta> {
    assertValidSessionId(thebeSessionId);
    if (!dir) {
      throw new Error("AgentStore has no directory");
    }
    const text = await readFile(join(dir, `${thebeSessionId}.json`), "utf8");
    const parsed = JSON.parse(text) as AgentSessionMeta;
    assertMetadataOnly(parsed as unknown as Record<string, unknown>);
    return parsed;
  }

  async function list(): Promise<AgentSessionMeta[]> {
    if (!dir) {
      return [];
    }
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const rows: AgentSessionMeta[] = [];
    for (const name of names.sort()) {
      rows.push(await load(name.replace(/\.json$/, "")));
    }
    return rows;
  }

  async function remove(thebeSessionId: string): Promise<void> {
    assertValidSessionId(thebeSessionId);
    if (!dir) {
      return;
    }
    try {
      await unlink(join(dir, `${thebeSessionId}.json`));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  return { save, load, list, delete: remove };
}
