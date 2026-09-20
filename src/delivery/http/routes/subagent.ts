import {
  toProductSubagentProfile,
  toProductWorker,
} from "../../../agent/subagents/product.ts";
import { agentUnavailable, quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, invalidBody, notFound } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH, PRODUCT_HTTP_SEGMENT } from "../product-paths.ts";

export async function handleSubagentRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith(PRODUCT_HTTP_PATH.subagents)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { request, parts, agent, url } = context;
  try {
    if (request.method === "GET" && parts.length === 3 && parts[2] === PRODUCT_HTTP_SEGMENT.profiles) {
      const profiles = (await agent.listSubagentProfiles()).map(toProductSubagentProfile);
      return json({ profiles });
    }
    if (request.method === "GET" && parts.length === 2) {
      const parentSessionId = url.searchParams.get("parentSessionId") ?? undefined;
      const subagents = agent.listSubagents(parentSessionId).map(toProductWorker);
      return json({ subagents });
    }
    if (request.method === "POST" && parts.length === 2) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const body = await readJson(request);
      const profileName = typeof body.profileName === "string" ? body.profileName.trim() : "";
      const task =
        (typeof body.task === "string" && body.task.trim()) ||
        (typeof body.taskPrompt === "string" && body.taskPrompt.trim()) ||
        "";
      const parentSessionId =
        typeof body.parentSessionId === "string" ? body.parentSessionId.trim() : "";
      if (!profileName || !task || !parentSessionId) {
        return invalidBody("profileName, task, and parentSessionId are required");
      }
      const run = await agent.spawnSubagent({ profileName, taskPrompt: task, parentSessionId });
      return json(toProductWorker(run), 201);
    }
    const runId = parts[2];
    if (!runId || parts.length < 3) return undefined;
    if (request.method === "GET" && parts.length === 3) {
      const run = agent.getSubagent(runId);
      if (!run) return notFound("subagent not found");
      return json(toProductWorker(run));
    }
    if (request.method === "GET" && parts.length === 4 && parts[3] === PRODUCT_HTTP_SEGMENT.log) {
      const run = agent.getSubagent(runId);
      if (!run) return notFound("subagent not found");
      return json({ activity: run.activity ?? [] });
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === PRODUCT_HTTP_SEGMENT.cancel) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      await agent.cancelSubagent(runId);
      const run = await agent.waitSubagent(runId);
      return json(toProductWorker(run));
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}
