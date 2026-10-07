import type { GoalScheduleInput } from "../../../agent/schedules/types.ts";
import { agentUnavailable, quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, invalidBody } from "../parsing/errors.ts";

export async function handleScheduleRoutes(context: ThebeHttpContext): Promise<Response | undefined> {
  const { parts, request, agent } = context;
  if (parts[0] !== "v1" || parts[1] !== "schedules") return undefined;
  if (!agent) return agentUnavailable();
  try {
    if (request.method === "GET" && parts.length === 2) return json({ schedules: await agent.listSchedules() });
    const id = parts[2];
    if (request.method === "GET" && parts.length === 3 && id) return json(await agent.getSchedule(id));
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
    if (request.method === "POST" && parts.length === 2) return json(await agent.createSchedule(await readJson(request) as GoalScheduleInput), 201);
    if (!id) return undefined;
    if (request.method === "PUT" && parts.length === 3) return json(await agent.updateSchedule(id, await readJson(request) as GoalScheduleInput));
    if (request.method === "PATCH" && parts.length === 3) {
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") return invalidBody("enabled must be a boolean");
      return json(await agent.setScheduleEnabled(id, body.enabled));
    }
    if (request.method === "DELETE" && parts.length === 3) { await agent.deleteSchedule(id); return json({ ok: true }); }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "run") return json(await agent.runSchedule(id));
    return undefined;
  } catch (error) { return agentError(error); }
}
