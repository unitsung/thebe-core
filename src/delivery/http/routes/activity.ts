import { toProductGoal } from "../../../agent/goals/product.ts";
import {
  capabilityRunToFeedItem,
  recordToFeedItem,
  toActivityFeed,
} from "../../../agent/activity/feed.ts";
import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";

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
    const records = await agent.listActivity();
    const goals = (await agent.listGoals()).map(toProductGoal);
    const capabilityRuns = await agent.listCapabilityRuns();
    return json({ items: toActivityFeed(records, goals, allowed, capabilityRuns) });
  }
  if (
    request.method === "POST" &&
    parts.length === 4 &&
    parts[1] === "activity" &&
    parts[3] === "deny"
  ) {
    const id = parts[2] ?? "";
    const ok = await agent.denyActivity(id);
    if (!ok) return json({ ok: false, error: "approval not found" }, 404);
    return json({ ok: true });
  }
  if (request.method === "GET" && parts.length === 3 && parts[1] === "activity") {
    const id = parts[2] ?? "";
    const record = await agent.getActivity(id);
    if (record) {
      const item = recordToFeedItem(record);
      if (item) return json(item);
    }
    const capabilityRun = await agent.getCapabilityRun(id);
    if (capabilityRun) return json(capabilityRunToFeedItem(capabilityRun));
    const goal = agent.getGoal(id);
    if (goal) {
      const items = toActivityFeed([], [toProductGoal(goal)]);
      if (items[0]) return json(items[0]);
    }
    return json({ ok: false, error: "activity not found" }, 404);
  }
  return undefined;
}
