import type { ProductGoal, ProductGoalStatus } from "../goals/product.ts";
import type { CapabilityRun } from "../capabilities/invoke.ts";
import { goalTicketKey } from "../tickets/types.ts";
import type { ProductWorker } from "../subagents/product.ts";
import {
  backgroundTaskActivityId,
  type ProductBackgroundTask,
} from "../background-tasks/product.ts";
import type { TriggerRecord } from "../sources/types.ts";
import type { ScheduleObservationView } from "../schedules/types.ts";
import {
  PERSON_REASONS,
  type ActivityStage,
  type PersonReason,
  type StageContext,
  type StageKind,
} from "./stage.ts";
import {
  backgroundTaskStage,
  goalStage,
  recordStage,
  runStage,
  scheduleObservationStage,
  triggerStage,
  workerStage,
} from "./stage-facts.ts";
import {
  ACTIVITY_KIND_DIAGNOSE,
  ACTIVITY_KIND_RESTART,
  assignActivityGroups,
  isPendingApproval,
  type ActivityGroup,
  type ActivityRecord,
} from "./types.ts";

export const ACTIVITY_FEED_TYPES = [
  "approval",
  "receipt",
  "diagnosis",
  "goal",
  "run",
  "worker",
  "background_task",
  "trigger",
  "schedule_observation",
] as const;

export type ActivityFeedType = (typeof ACTIVITY_FEED_TYPES)[number];

export const DEFAULT_ACTIVITY_LIMIT = 50;
export const MAX_ACTIVITY_LIMIT = 100;

export type ActivityCursor = {
  updatedAt: string;
  id: string;
};

/**
 * Where the item stands with respect to the person, derived on every read and never stored, and the
 * ticket that wraps the item when one does (additive: absent on items no ticket wraps).
 */
export type ActivityFeedItemStage = {
  stage: ActivityStage;
  ticketId?: string;
};

export type ActivityFeedItem = ActivityFeedItemStage &
  (
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
        type: "diagnosis";
        id: string;
        group: "recent";
        updatedAt: string;
        diagnosis: ActivityRecord;
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
      }
    | {
        /** An event from a source and the Gate's recorded outcome for it. */
        type: "trigger";
        id: string;
        group: "recent";
        updatedAt: string;
        trigger: TriggerRecord;
      }
    | {
        /** What an observed schedule would have run at its due time; nothing was started. */
        type: "schedule_observation";
        id: string;
        group: "recent";
        updatedAt: string;
        observation: ScheduleObservationView;
      }
  );

export type ActivityFeedPage = {
  items: ActivityFeedItem[];
  nextCursor?: string;
};

export type ActivityFeedFilters = {
  source?: ActivityFeedType;
  status?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  stage?: StageKind;
};

export const ACTIVITY_STAGE_KINDS = [
  "ended",
  "person",
  "working",
  "idle",
] as const satisfies readonly StageKind[];

export function goalActivityGroup(
  status: ProductGoalStatus
): Exclude<ActivityGroup, "needs_approval"> {
  if (status === "queued" || status === "running" || status === "paused") {
    return "running";
  }
  return "recent";
}

export function recordToFeedItem(
  record: ActivityRecord,
  context: StageContext = {}
): ActivityFeedItem | undefined {
  const grouped = assignActivityGroups([record])[0] ?? record;
  const stage = recordStage(grouped, context);
  if (isPendingApproval(grouped)) {
    return {
      stage,
      type: "approval",
      id: grouped.id,
      group: "needs_approval",
      updatedAt: grouped.updatedAt,
      approval: grouped,
    };
  }
  if (grouped.kind === ACTIVITY_KIND_DIAGNOSE) {
    return {
      stage,
      type: "diagnosis",
      id: grouped.id,
      group: "recent",
      updatedAt: grouped.updatedAt,
      diagnosis: grouped,
    };
  }
  if (grouped.kind === ACTIVITY_KIND_RESTART && grouped.action) {
    return {
      stage,
      type: "receipt",
      id: grouped.id,
      group: grouped.group === "running" ? "running" : "recent",
      updatedAt: grouped.updatedAt,
      receipt: grouped,
    };
  }
  return undefined;
}

export function goalToFeedItem(
  goal: ProductGoal,
  context: StageContext = {}
): ActivityFeedItem {
  const group = goalActivityGroup(goal.status);
  const ticketId =
    goal.ticketId ??
    context.ticketIds?.get(goalTicketKey(goal.id, goal.createdAt));
  return {
    stage: goalStage(goal, context),
    ...(ticketId ? { ticketId } : {}),
    type: "goal",
    id: goal.id,
    group,
    updatedAt: goal.updatedAt,
    goal: ticketId ? { ...goal, ticketId } : goal,
  };
}

export function capabilityRunToFeedItem(
  run: CapabilityRun,
  context: StageContext = {}
): ActivityFeedItem {
  const group =
    run.status === "queued" || run.status === "running" ? "running" : "recent";
  return {
    stage: runStage(run, context),
    type: "run",
    id: run.runId,
    group,
    updatedAt: run.updatedAt ?? run.finishedAt ?? run.createdAt,
    run,
  };
}

export function workerActivityGroup(
  status: ProductWorker["status"]
): Exclude<ActivityGroup, "needs_approval"> {
  return status === "queued" || status === "running" ? "running" : "recent";
}

export function workerToFeedItem(
  run: ProductWorker,
  context: StageContext = {}
): ActivityFeedItem {
  return {
    stage: workerStage(run, context),
    type: "worker",
    id: run.runId,
    group: workerActivityGroup(run.status),
    updatedAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
    worker: run,
  };
}

export function backgroundTaskToFeedItem(
  task: ProductBackgroundTask,
  context: StageContext = {}
): ActivityFeedItem {
  return {
    stage: backgroundTaskStage(task, context),
    type: "background_task",
    id: backgroundTaskActivityId(task.sessionId, task.id),
    group: task.status === "running" ? "running" : "recent",
    updatedAt: task.updatedAt,
    task,
  };
}

export function triggerToFeedItem(
  record: TriggerRecord,
  context: StageContext = {}
): ActivityFeedItem {
  return {
    stage: triggerStage(record, context),
    type: "trigger",
    id: record.trigger.id,
    group: "recent",
    updatedAt: record.decidedAt,
    trigger: record,
  };
}

export function scheduleObservationToFeedItem(
  record: ScheduleObservationView,
  context: StageContext = {}
): ActivityFeedItem {
  return {
    stage: scheduleObservationStage(record, context),
    type: "schedule_observation",
    id: record.id,
    group: "recent",
    updatedAt: record.observedAt,
    observation: record,
  };
}

export function encodeActivityCursor(
  item: Pick<ActivityFeedItem, "updatedAt" | "id">
): string {
  return Buffer.from(
    JSON.stringify({ version: 1, updatedAt: item.updatedAt, id: item.id }),
    "utf8"
  ).toString("base64url");
}

export function decodeActivityCursor(
  value: string
): ActivityCursor | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as {
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
  options: { limit?: number; cursor?: string } = {}
): ActivityFeedPage {
  const sorted = [...items].sort(compareActivityItems);
  const cursor = options.cursor
    ? decodeActivityCursor(options.cursor)
    : undefined;
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
  filters: ActivityFeedFilters = {}
): ActivityFeedItem[] {
  const updatedAfter = filters.updatedAfter
    ? Date.parse(filters.updatedAfter)
    : undefined;
  const updatedBefore = filters.updatedBefore
    ? Date.parse(filters.updatedBefore)
    : undefined;
  return items.filter((item) => {
    if (filters.source && item.type !== filters.source) return false;
    if (filters.status && activityFeedItemStatus(item) !== filters.status)
      return false;
    if (filters.stage && item.stage.kind !== filters.stage) return false;
    const updatedAt = Date.parse(item.updatedAt);
    if (updatedAfter !== undefined && updatedAt < updatedAfter) return false;
    if (updatedBefore !== undefined && updatedAt > updatedBefore) return false;
    return true;
  });
}

/** The needs-you summary and the list it opens are both read from the same items, so they cannot differ. */
export type NeedsYouSummary = {
  count: number;
  reasons: Record<PersonReason, number>;
};

export function summarizeNeedsYou(items: ActivityFeedItem[]): NeedsYouSummary {
  const reasons = Object.fromEntries(
    PERSON_REASONS.map((reason) => [reason, 0])
  ) as Record<PersonReason, number>;
  let count = 0;
  for (const item of items) {
    if (item.stage.kind !== "person") continue;
    count += 1;
    reasons[item.stage.reason] += 1;
  }
  return { count, reasons };
}

function activityFeedItemStatus(item: ActivityFeedItem): string {
  switch (item.type) {
    case "approval":
      return item.approval.status;
    case "receipt":
      return item.receipt.status;
    case "diagnosis":
      return item.diagnosis.status;
    case "goal":
      return item.goal.status;
    case "run":
      return item.run.status;
    case "worker":
      return item.worker.status;
    case "background_task":
      return item.task.status;
    case "trigger":
      return item.trigger.outcome.result;
    case "schedule_observation":
      return "would_run";
  }
}

export function toActivityFeed(
  records: ActivityRecord[],
  goals: ProductGoal[],
  group?: ActivityGroup,
  capabilityRuns: CapabilityRun[] = [],
  workers: ProductWorker[] = [],
  backgroundTasks: ProductBackgroundTask[] = [],
  stageContext: StageContext = {},
  triggers: TriggerRecord[] = [],
  scheduleObservations: ScheduleObservationView[] = []
): ActivityFeedItem[] {
  const items: ActivityFeedItem[] = [];
  for (const record of records) {
    const item = recordToFeedItem(record, stageContext);
    if (item) items.push(item);
  }
  for (const goal of goals) {
    items.push(goalToFeedItem(goal, stageContext));
  }
  for (const run of capabilityRuns) {
    items.push(capabilityRunToFeedItem(run, stageContext));
  }
  for (const worker of workers) {
    items.push(workerToFeedItem(worker, stageContext));
  }
  for (const task of backgroundTasks) {
    items.push(backgroundTaskToFeedItem(task, stageContext));
  }
  for (const record of triggers) {
    items.push(triggerToFeedItem(record, stageContext));
  }
  for (const record of scheduleObservations) {
    items.push(scheduleObservationToFeedItem(record, stageContext));
  }
  items.sort(compareActivityItems);
  return group ? items.filter((item) => item.group === group) : items;
}

function compareActivityItems(
  left: Pick<ActivityFeedItem, "updatedAt" | "id">,
  right: Pick<ActivityFeedItem, "updatedAt" | "id">
): number {
  if (left.updatedAt < right.updatedAt) return 1;
  if (left.updatedAt > right.updatedAt) return -1;
  if (left.id < right.id) return 1;
  if (left.id > right.id) return -1;
  return 0;
}
