import type { ProductGoal, ProductGoalStatus } from "../goals/product.ts";
import type { CapabilityRun } from "../capabilities/invoke.ts";
import type { ProductWorker } from "../subagents/product.ts";
import {
  backgroundTaskActivityId,
  type ProductBackgroundTask,
} from "../background-tasks/product.ts";
import {
  ACTIVITY_KIND_DIAGNOSE,
  ACTIVITY_KIND_RESTART,
  assignActivityGroups,
  hasRestartRecommendation,
  isPendingApproval,
  type ActivityGroup,
  type ActivityRecord,
} from "./types.ts";

export const ACTIVITY_FEED_TYPES = [
  "approval",
  "receipt",
  "goal",
  "run",
  "worker",
  "background_task",
] as const;

export type ActivityFeedType = (typeof ACTIVITY_FEED_TYPES)[number];

export const DEFAULT_ACTIVITY_LIMIT = 50;
export const MAX_ACTIVITY_LIMIT = 100;

export type ActivityCursor = {
  updatedAt: string;
  id: string;
};

export type ActivityFeedItem =
  | {
      type: "approval";
      id: string;
      group: "needs_approval";
      updatedAt: string;
      approval: ActivityRecord;
    }
  | {
      type: "receipt";
      id: string;
      group: "running" | "recent";
      updatedAt: string;
      receipt: ActivityRecord;
    }
  | {
      type: "goal";
      id: string;
      group: "running" | "recent";
      updatedAt: string;
      goal: ProductGoal;
    }
  | {
      type: "run";
      id: string;
      group: "running" | "recent";
      updatedAt: string;
      run: CapabilityRun;
    }
  | {
      type: "worker";
      id: string;
      group: "running" | "recent";
      updatedAt: string;
      worker: ProductWorker;
    }
  | {
      type: "background_task";
      id: string;
      group: "running" | "recent";
      updatedAt: string;
      task: ProductBackgroundTask;
    };

export type ActivityFeedPage = {
  items: ActivityFeedItem[];
  nextCursor?: string;
};

export type ActivityFeedFilters = {
  source?: ActivityFeedType;
  status?: string;
  updatedAfter?: string;
  updatedBefore?: string;
};

export function goalActivityGroup(
  status: ProductGoalStatus,
): Exclude<ActivityGroup, "needs_approval"> {
  if (status === "queued" || status === "running" || status === "paused") {
    return "running";
  }
  return "recent";
}

export function recordToFeedItem(record: ActivityRecord): ActivityFeedItem | undefined {
  const grouped = assignActivityGroups([record])[0] ?? record;
  if (grouped.kind === ACTIVITY_KIND_DIAGNOSE && !hasRestartRecommendation(grouped)) {
    return undefined;
  }
  if (isPendingApproval(grouped)) {
    return {
      type: "approval",
      id: grouped.id,
      group: "needs_approval",
      updatedAt: grouped.updatedAt,
      approval: grouped,
    };
  }
  if (grouped.kind === ACTIVITY_KIND_RESTART && grouped.action) {
    return {
      type: "receipt",
      id: grouped.id,
      group: grouped.group === "running" ? "running" : "recent",
      updatedAt: grouped.updatedAt,
      receipt: grouped,
    };
  }
  return undefined;
}

export function goalToFeedItem(goal: ProductGoal): ActivityFeedItem {
  const group = goalActivityGroup(goal.status);
  return {
    type: "goal",
    id: goal.id,
    group,
    updatedAt: goal.updatedAt,
    goal,
  };
}

export function capabilityRunToFeedItem(run: CapabilityRun): ActivityFeedItem {
  const group = run.status === "queued" || run.status === "running" ? "running" : "recent";
  return {
    type: "run",
    id: run.runId,
    group,
    updatedAt: run.updatedAt ?? run.finishedAt ?? run.createdAt,
    run,
  };
}

export function workerActivityGroup(
  status: ProductWorker["status"],
): Exclude<ActivityGroup, "needs_approval"> {
  return status === "queued" || status === "running" ? "running" : "recent";
}

export function workerToFeedItem(run: ProductWorker): ActivityFeedItem {
  return {
    type: "worker",
    id: run.runId,
    group: workerActivityGroup(run.status),
    updatedAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
    worker: run,
  };
}

export function backgroundTaskToFeedItem(task: ProductBackgroundTask): ActivityFeedItem {
  return {
    type: "background_task",
    id: backgroundTaskActivityId(task.sessionId, task.id),
    group: task.status === "running" ? "running" : "recent",
    updatedAt: task.updatedAt,
    task,
  };
}

export function encodeActivityCursor(item: Pick<ActivityFeedItem, "updatedAt" | "id">): string {
  return Buffer.from(
    JSON.stringify({ version: 1, updatedAt: item.updatedAt, id: item.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeActivityCursor(value: string): ActivityCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      version?: unknown;
      updatedAt?: unknown;
      id?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.id !== "string" ||
      !parsed.updatedAt ||
      !parsed.id
    ) {
      return undefined;
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

export function normalizeActivityLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    return DEFAULT_ACTIVITY_LIMIT;
  }
  return Math.min(value as number, MAX_ACTIVITY_LIMIT);
}

export function paginateActivityFeed(
  items: ActivityFeedItem[],
  options: { limit?: number; cursor?: string } = {},
): ActivityFeedPage {
  const sorted = [...items].sort(compareActivityItems);
  const cursor = options.cursor ? decodeActivityCursor(options.cursor) : undefined;
  const afterCursor = cursor
    ? sorted.filter((item) => compareActivityItems(item, cursor) > 0)
    : sorted;
  const page = afterCursor.slice(0, normalizeActivityLimit(options.limit));
  return {
    items: page,
    ...(afterCursor.length > page.length && page.at(-1)
      ? { nextCursor: encodeActivityCursor(page.at(-1)!) }
      : {}),
  };
}

export function filterActivityFeed(
  items: ActivityFeedItem[],
  filters: ActivityFeedFilters = {},
): ActivityFeedItem[] {
  const updatedAfter = filters.updatedAfter ? Date.parse(filters.updatedAfter) : undefined;
  const updatedBefore = filters.updatedBefore ? Date.parse(filters.updatedBefore) : undefined;
  return items.filter((item) => {
    if (filters.source && item.type !== filters.source) return false;
    if (filters.status && activityFeedItemStatus(item) !== filters.status) return false;
    const updatedAt = Date.parse(item.updatedAt);
    if (updatedAfter !== undefined && updatedAt < updatedAfter) return false;
    if (updatedBefore !== undefined && updatedAt > updatedBefore) return false;
    return true;
  });
}

function activityFeedItemStatus(item: ActivityFeedItem): string {
  switch (item.type) {
    case "approval":
      return item.approval.status;
    case "receipt":
      return item.receipt.status;
    case "goal":
      return item.goal.status;
    case "run":
      return item.run.status;
    case "worker":
      return item.worker.status;
    case "background_task":
      return item.task.status;
  }
}

export function toActivityFeed(
  records: ActivityRecord[],
  goals: ProductGoal[],
  group?: ActivityGroup,
  capabilityRuns: CapabilityRun[] = [],
  workers: ProductWorker[] = [],
  backgroundTasks: ProductBackgroundTask[] = [],
): ActivityFeedItem[] {
  const items: ActivityFeedItem[] = [];
  for (const record of records) {
    const item = recordToFeedItem(record);
    if (item) items.push(item);
  }
  for (const goal of goals) {
    items.push(goalToFeedItem(goal));
  }
  for (const run of capabilityRuns) {
    items.push(capabilityRunToFeedItem(run));
  }
  for (const worker of workers) {
    items.push(workerToFeedItem(worker));
  }
  for (const task of backgroundTasks) {
    items.push(backgroundTaskToFeedItem(task));
  }
  items.sort(compareActivityItems);
  return group ? items.filter((item) => item.group === group) : items;
}

function compareActivityItems(
  left: Pick<ActivityFeedItem, "updatedAt" | "id">,
  right: Pick<ActivityFeedItem, "updatedAt" | "id">,
): number {
  if (left.updatedAt < right.updatedAt) return 1;
  if (left.updatedAt > right.updatedAt) return -1;
  if (left.id < right.id) return 1;
  if (left.id > right.id) return -1;
  return 0;
}
