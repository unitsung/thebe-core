import { json, readJson } from "../json.ts";
import { quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { parseDeviceCategories } from "../devices.ts";
import { QuietHoursError } from "../quiet-hours.ts";
import { handleCompatibility } from "./compat.ts";

/** Health, event collection, device-registration, and legacy message routes. */
export async function handleHealthEventsCompatibility(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const { request, path, parts, agent, deviceRegistry } = context;
  if (request.method === "GET" && path === "/v1/health") {
    // What this Core can do beyond the basics: list Tickets, hold a Policy, and keep Decisions.
    return json({
      ok: true,
      version: context.version,
      capabilities: context.agent ? ["tickets", "policy", "decisions"] : [],
    });
  }
  if (
    request.method === "GET" &&
    (path === "/v1/events" || path === "/v1/event")
  ) {
    return json({ events: agent ? agent.recentEvents() : [] });
  }
  if (request.method === "GET" && path === "/v1/push/identity") {
    const { pushIdentity } = context;
    return json({
      ok: true,
      available: pushIdentity !== undefined,
      publicKey: pushIdentity?.publicKey ?? null,
      relayUrl: pushIdentity?.relayUrl ?? null,
    });
  }
  if (path === "/v1/push/quiet-hours") {
    const { quietHours } = context;
    if (!quietHours) {
      return json({ ok: false, error: "quiet hours unavailable" }, 503);
    }
    if (request.method === "GET") {
      return json({ quietHours: (await quietHours.get()) ?? null });
    }
    if (request.method === "PUT") {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const body = await readJson(request);
      try {
        // `null` (or leaving it out) turns quiet hours off.
        return json({
          quietHours: (await quietHours.set(body.quietHours)) ?? null,
        });
      } catch (error) {
        if (error instanceof QuietHoursError) {
          return json(
            { ok: false, error: error.message, code: "invalid_quiet_hours" },
            400
          );
        }
        throw error;
      }
    }
    return json(
      { ok: false, error: "Use GET or PUT", code: "method_not_allowed" },
      405
    );
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
    const platform =
      typeof body.platform === "string"
        ? body.platform.trim().toLowerCase()
        : "";
    if (!token || token.length > 512) {
      return json(
        {
          ok: false,
          error: "token is required and must be at most 512 characters",
        },
        400
      );
    }
    if (platform !== "ios") {
      return json({ ok: false, error: "platform must be 'ios'" }, 400);
    }
    const categoryResult = parseDeviceCategories(body.categories);
    if (!categoryResult.ok) {
      return json({ ok: false, error: categoryResult.error }, 400);
    }
    const deviceId =
      typeof body.deviceId === "string" && body.deviceId.trim()
        ? body.deviceId.trim()
        : undefined;
    const relayDeviceId =
      typeof body.relayDeviceId === "string" && body.relayDeviceId.trim()
        ? body.relayDeviceId.trim()
        : undefined;
    if (relayDeviceId && relayDeviceId.length > 128) {
      return json(
        { ok: false, error: "relayDeviceId must be at most 128 characters" },
        400
      );
    }
    if (!deviceRegistry) {
      return json({ ok: false, error: "device registry unavailable" }, 503);
    }
    const registration = await deviceRegistry.register({
      token,
      platform,
      deviceId,
      relayDeviceId,
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
