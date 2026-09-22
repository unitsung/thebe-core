import { toProductGoal } from "../../../agent/goals/product.ts";
import {
  ACTIVITY_FEED_TYPES,
  backgroundTaskToFeedItem,
  capabilityRunToFeedItem,
  decodeActivityCursor,
  filterActivityFeed,
  MAX_ACTIVITY_LIMIT,
  normalizeActivityLimit,
  paginateActivityFeed,
  recordToFeedItem,
  toActivityFeed,
  workerToFeedItem,
} from "../../../agent/activity/feed.ts";
import { backgroundTaskActivityId } from "../../../agent/background-tasks/product.ts";
import { toProductWorker } from "../../../agent/subagents/product.ts";
import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { invalidBody } from "../parsing/errors.ts";

export async function handleActivityRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith("/v1/activity")) {
    return undefined;
  }
  if (!context.agent) {
    return agentUnavailable();
  }
  const { request, parts, agent } = context;
  if (request.method === "GET" && context.path === "/v1/activity") {
    const group = context.url.searchParams.get("group");
    const allowed =
      group === "needs_approval" || group === "running" || group === "recent"
        ? group
        : undefined;
    const rawSource = context.url.searchParams.get("source");
    const source = rawSource === null ? undefined : ACTIVITY_FEED_TYPES.find((item) => item === rawSource);
    if (rawSource !== null && !source) {
      return invalidBody("source is invalid");
    }
    const rawStatus = context.url.searchParams.get("status");
    if (rawStatus !== null && !rawStatus.trim()) {
      return invalidBody("status must not be empty");
    }
    const rawUpdatedAfter = context.url.searchParams.get("updatedAfter");
    if (rawUpdatedAfter !== null && !isTimestamp(rawUpdatedAfter)) {
      return invalidBody("updatedAfter must be an ISO-8601 timestamp");
    }
    const rawUpdatedBefore = context.url.searchParams.get("updatedBefore");
    if (rawUpdatedBefore !== null && !isTimestamp(rawUpdatedBefore)) {
      return invalidBody("updatedBefore must be an ISO-8601 timestamp");
    }
    const rawLimit = context.url.searchParams.get("limit");
    let limit: number | undefined;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return invalidBody("limit must be a positive integer");
      }
      limit = Math.min(parsed, MAX_ACTIVITY_LIMIT);
    }
    const rawCursor = context.url.searchParams.get("cursor");
    if (rawCursor && !decodeActivityCursor(rawCursor)) {
      return invalidBody("cursor is invalid");
    }
    const records = await agent.listActivity();
    const goals = (await agent.listGoals()).map(toProductGoal);
    const capabilityRuns = await agent.listCapabilityRuns();
    const workers = (await agent.listSubagents()).map(toProductWorker);
    const backgroundTasks = await agent.listAllBackgroundTasks();
    const items = filterActivityFeed(
      toActivityFeed(records, goals, allowed, capabilityRuns, workers, backgroundTasks),
      {
        source,
        status: rawStatus?.trim() || undefined,
        updatedAfter: rawUpdatedAfter || undefined,
        updatedBefore: rawUpdatedBefore || undefined,
      },
    );
    return json(
      paginateActivityFeed(items, {
        limit: normalizeActivityLimit(limit),
        cursor: rawCursor || undefined,
      }),
    );
  }
  if (
    request.method === "POST" &&
    parts.length === 4 &&
    parts[1] === "activity" &&
    parts[3] === "deny"
  ) {
    const id = decodePathPart(parts[2]);
    const ok = await agent.denyActivity(id);
    if (!ok) return json({ ok: false, error: "approval not found" }, 404);
    return json({ ok: true });
  }
  if (request.method === "GET" && parts.length === 3 && parts[1] === "activity") {
    const id = decodePathPart(parts[2]);
    const record = await agent.getActivity(id);
    if (record) {
      const item = recordToFeedItem(record);
      if (item) return json(item);
    }
    const capabilityRun = await agent.getCapabilityRun(id);
    if (capabilityRun) return json(capabilityRunToFeedItem(capabilityRun));
    const worker = (await agent.listSubagents())
      .map(toProductWorker)
      .find((item) => item.runId === id);
    if (worker) return json(workerToFeedItem(worker));
    const backgroundTask = (await agent.listAllBackgroundTasks()).find(
      (item) => backgroundTaskActivityId(item.sessionId, item.id) === id,
    );
    if (backgroundTask) return json(backgroundTaskToFeedItem(backgroundTask));
    let goal = agent.getGoal(id);
    if (!goal) {
      goal = (await agent.listGoals()).find(
        (item) => item.thebeSessionId === id,
      );
    }
    if (goal) {
      const items = toActivityFeed([], [toProductGoal(goal)]);
      if (items[0]) return json(items[0]);
    }
    return json({ ok: false, error: "activity not found" }, 404);
  }
  return undefined;
}

function isTimestamp(value: string): boolean {
  return Boolean(value.trim()) && !Number.isNaN(Date.parse(value));
}

function decodePathPart(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    return value ?? "";
  }
}
