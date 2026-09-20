import type { ProductGoal, ProductGoalStatus } from "../goals/product.ts";
import {
  ACTIVITY_KIND_DIAGNOSE,
  ACTIVITY_KIND_RESTART,
  assignActivityGroups,
  hasRestartRecommendation,
  isPendingApproval,
  type ActivityGroup,
  type ActivityRecord,
} from "./types.ts";

export type ActivityFeedType = "approval" | "receipt" | "goal";

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

export function toActivityFeed(
  records: ActivityRecord[],
  goals: ProductGoal[],
  group?: ActivityGroup,
): ActivityFeedItem[] {
  const items: ActivityFeedItem[] = [];
  for (const record of records) {
    const item = recordToFeedItem(record);
    if (item) items.push(item);
  }
  for (const goal of goals) {
    items.push(goalToFeedItem(goal));
  }
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return group ? items.filter((item) => item.group === group) : items;
}
