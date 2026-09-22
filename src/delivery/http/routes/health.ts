import { json, readJson } from "../json.ts";
import { quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { parseDeviceCategories } from "../devices.ts";
import { handleCompatibility } from "./compat.ts";

/** Health, event collection, device-registration, and legacy message routes. */
export async function handleHealthEventsCompatibility(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  const { request, path, parts, agent, deviceRegistry } = context;
  if (request.method === "GET" && path === "/v1/health") {
    return json({ ok: true, version: context.version });
  }
  if (
    request.method === "GET" &&
    (path === "/v1/events" || path === "/v1/event")
  ) {
    return json({ events: agent ? agent.recentEvents() : [] });
  }
  if (request.method === "GET" && path === "/v1/devices") {
    if (!deviceRegistry) {
      return json({ ok: false, error: "device registry unavailable" }, 503);
    }
    return json({ devices: await deviceRegistry.list() });
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
    const categoryResult = parseDeviceCategories(body.categories);
    if (!categoryResult.ok) {
      return json({ ok: false, error: categoryResult.error }, 400);
    }
    const deviceId = typeof body.deviceId === "string" && body.deviceId.trim()
      ? body.deviceId.trim()
      : undefined;
    if (!deviceRegistry) {
      return json({ ok: false, error: "device registry unavailable" }, 503);
    }
    const registration = await deviceRegistry.register({
      token,
      platform,
      deviceId,
      categories: categoryResult.categories,
    });
    return json({ ok: true, registered: true, ...registration });
  }
  if (
    request.method === "DELETE" &&
    parts.length === 3 &&
    parts[0] === "v1" &&
    parts[1] === "devices"
  ) {
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
    if (!deviceRegistry) {
      return json({ ok: false, error: "device registry unavailable" }, 503);
    }
    const registrationId = parts[2];
    if (!registrationId) return json({ ok: false }, 404);
    const removed = await deviceRegistry.remove(registrationId);
    if (!removed) return json({ ok: false }, 404);
    return json({ ok: true, removed: true, registrationId });
  }
  if (request.method === "POST" && path === "/v1/messages") {
    return handleCompatibility(context);
  }
  return undefined;
}
