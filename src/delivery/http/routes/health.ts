import { json } from "../json.ts";
import type { ThebeHttpContext } from "../context.ts";
import { handleCompatibility } from "./compat.ts";

/** Health, event collection, device-registration, and legacy message routes. */
export async function handleHealthEventsCompatibility(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  const { request, path, agent } = context;
  if (request.method === "GET" && path === "/v1/health") {
    return json({ ok: true, version: context.version });
  }
  if (
    request.method === "GET" &&
    (path === "/v1/events" || path === "/v1/event")
  ) {
    return json({ events: agent ? agent.recentEvents() : [] });
  }
  if (request.method === "POST" && path === "/v1/devices") {
    // TODO: validate and persist device registration
    return json({ ok: true });
  }
  if (request.method === "POST" && path === "/v1/messages") {
    return handleCompatibility(context);
  }
  return undefined;
}
