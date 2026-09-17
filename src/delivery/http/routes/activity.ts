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
    return json({ activities: await agent.listActivity() });
  }
  if (request.method === "GET" && parts.length === 3 && parts[1] === "activity") {
    const id = parts[2] ?? "";
    const record = await agent.getActivity(id);
    if (!record) return json({ ok: false, error: "activity not found" }, 404);
    return json(record);
  }
  return undefined;
}
