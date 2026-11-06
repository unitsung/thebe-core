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
import {
  ACTIVITY_STAGES,
  activityStage,
  withStage,
} from "../../../agent/activity/stage.ts";
import { backgroundTaskActivityId } from "../../../agent/background-tasks/product.ts";
import { toProductWorker } from "../../../agent/subagents/product.ts";
import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { invalidBody } from "../parsing/errors.ts";

export async function handleActivityRoutes(
  context: ThebeHttpContext
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
    const source =
      rawSource === null
        ? undefined
        : ACTIVITY_FEED_TYPES.find((item) => item === rawSource);
    if (rawSource !== null && !source) {
      return invalidBody("source is invalid");
    }
    const rawStage = context.url.searchParams.get("stage");
    const stage =
      rawStage === null
        ? undefined
        : ACTIVITY_STAGES.find((item) => item === rawStage);
    if (rawStage !== null && !stage) {
      return invalidBody(`stage must be ${ACTIVITY_STAGES.join(", ")}`);
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
    const now = new Date();
    const filtered = filterActivityFeed(
      toActivityFeed(
        records,
        goals,
        allowed,
        capabilityRuns,
        workers,
        backgroundTasks
      ),
      {
        source,
        status: rawStatus?.trim() || undefined,
        updatedAfter: rawUpdatedAfter || undefined,
        updatedBefore: rawUpdatedBefore || undefined,
      }
    );
    // The same stage the items carry, so a count of `stage=person` is the length of the list it opens.
    const items = stage
      ? filtered.filter((item) => activityStage(item, now).stage === stage)
      : filtered;
    const page = paginateActivityFeed(items, {
      limit: normalizeActivityLimit(limit),
      cursor: rawCursor || undefined,
    });
    return json({
      ...page,
      items: page.items.map((item) => withStage(item, now)),
    });
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
  if (
    request.method === "GET" &&
    parts.length === 3 &&
    parts[1] === "activity"
  ) {
    const id = decodePathPart(parts[2]);
    const record = await agent.getActivity(id);
    if (record) {
      const item = recordToFeedItem(record);
      if (item) return json(withStage(item));
    }
    const capabilityRun = await agent.getCapabilityRun(id);
    if (capabilityRun)
      return json(withStage(capabilityRunToFeedItem(capabilityRun)));
    const worker = (await agent.listSubagents())
      .map(toProductWorker)
      .find((item) => item.runId === id);
    if (worker) return json(withStage(workerToFeedItem(worker)));
    const backgroundTask = (await agent.listAllBackgroundTasks()).find(
      (item) => backgroundTaskActivityId(item.sessionId, item.id) === id
    );
    if (backgroundTask)
      return json(withStage(backgroundTaskToFeedItem(backgroundTask)));
    let goal = agent.getGoal(id);
    if (!goal) {
      goal = (await agent.listGoals()).find(
        (item) => item.thebeSessionId === id
      );
    }
    if (goal) {
      const items = toActivityFeed([], [toProductGoal(goal)]);
      if (items[0]) return json(withStage(items[0]));
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
