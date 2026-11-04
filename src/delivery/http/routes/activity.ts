import { toProductGoal } from "../../../agent/goals/product.ts";
import {
  ACTIVITY_FEED_TYPES,
  ACTIVITY_STAGE_KINDS,
  summarizeNeedsYou,
  backgroundTaskToFeedItem,
  capabilityRunToFeedItem,
  decodeActivityCursor,
  filterActivityFeed,
  MAX_ACTIVITY_LIMIT,
  normalizeActivityLimit,
  paginateActivityFeed,
  recordToFeedItem,
  toActivityFeed,
  triggerToFeedItem,
  workerToFeedItem,
} from "../../../agent/activity/feed.ts";
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
    const rawStage = context.url.searchParams.get("stage");
    const stage =
      rawStage === null
        ? undefined
        : ACTIVITY_STAGE_KINDS.find((item) => item === rawStage);
    if (rawStage !== null && !stage) {
      return invalidBody("stage is invalid");
    }
    const items = filterActivityFeed(await collectFeed(agent, allowed), {
      source,
      stage,
      status: rawStatus?.trim() || undefined,
      updatedAfter: rawUpdatedAfter || undefined,
      updatedBefore: rawUpdatedBefore || undefined,
    });
    return json(
      paginateActivityFeed(items, {
        limit: normalizeActivityLimit(limit),
        cursor: rawCursor || undefined,
      })
    );
  }
  if (request.method === "GET" && context.path === "/v1/activity/summary") {
    // Counted over every item, not one page, from the same function the stage=person list uses.
    return json({ needsYou: summarizeNeedsYou(await collectFeed(agent)) });
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
    const stageContext = agent.activityStageContext();
    const record = await agent.getActivity(id);
    if (record) {
      const item = recordToFeedItem(record, stageContext);
      if (item) return json(item);
    }
    const capabilityRun = await agent.getCapabilityRun(id);
    if (capabilityRun)
      return json(capabilityRunToFeedItem(capabilityRun, stageContext));
    const trigger = (await agent.listTriggers()).find(
      (item) => item.trigger.id === id
    );
    if (trigger) return json(triggerToFeedItem(trigger, stageContext));
    const worker = (await agent.listSubagents())
      .map(toProductWorker)
      .find((item) => item.runId === id);
    if (worker) return json(workerToFeedItem(worker, stageContext));
    const backgroundTask = (await agent.listAllBackgroundTasks()).find(
      (item) => backgroundTaskActivityId(item.sessionId, item.id) === id
    );
    if (backgroundTask)
      return json(backgroundTaskToFeedItem(backgroundTask, stageContext));
    let goal = agent.getGoal(id);
    if (!goal) {
      goal = (await agent.listGoals()).find(
        (item) => item.thebeSessionId === id
      );
    }
    if (goal) {
      const items = toActivityFeed(
        [],
        [toProductGoal(goal)],
        undefined,
        [],
        [],
        [],
        stageContext
      );
      if (items[0]) return json(items[0]);
    }
    return json({ ok: false, error: "activity not found" }, 404);
  }
  return undefined;
}

type Agent = NonNullable<ThebeHttpContext["agent"]>;

/** Every Activity item with its stage; the one place the list, the filters and the summary read from. */
async function collectFeed(
  agent: Agent,
  group?: "needs_approval" | "running" | "recent"
) {
  const records = await agent.listActivity();
  const goals = (await agent.listGoals()).map(toProductGoal);
  const capabilityRuns = await agent.listCapabilityRuns();
  const workers = (await agent.listSubagents()).map(toProductWorker);
  const backgroundTasks = await agent.listAllBackgroundTasks();
  return toActivityFeed(
    records,
    goals,
    group,
    capabilityRuns,
    workers,
    backgroundTasks,
    agent.activityStageContext(),
    await agent.listTriggers()
  );
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
