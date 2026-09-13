import { createHash } from "node:crypto";
import { json, readJson } from "../json.ts";
import { quiescedWrite, type ThebeHttpContext } from "../context.ts";
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
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
    const body = await readJson(request);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const platform = typeof body.platform === "string" ? body.platform.trim().toLowerCase() : "";
    if (!token || token.length > 512) {
      return json({ ok: false, error: "token is required and must be at most 512 characters" }, 400);
    }
    if (platform !== "ios") {
      return json({ ok: false, error: "platform must be 'ios'" }, 400);
    }
    const deviceId = typeof body.deviceId === "string" && body.deviceId.trim()
      ? body.deviceId.trim()
      : undefined;
    const registrationKey = createHash("sha256").update(token).digest("hex");
    const registeredAt = new Date().toISOString();
    context.devices?.set(registrationKey, { platform, deviceId, registeredAt });
    return json({ ok: true, registered: true, deviceId, registeredAt });
  }
  if (request.method === "POST" && path === "/v1/messages") {
    return handleCompatibility(context);
  }
  return undefined;
}
