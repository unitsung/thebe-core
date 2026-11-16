import { quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { NotificationInputError } from "../../../agent/notifications/settings.ts";
import {
  NOTIFICATION_CHANNEL_CONFIG_GROUPS,
  NotificationChannelConfigError,
  redactNotificationChannelConfig,
  restoreNotificationChannelConfigSecrets,
} from "../../../agent/notifications/channel-config.ts";
import { redactToolOutput } from "../../../agent/security/redaction.ts";

/** Settings, test sends, status, and the external `send` entry point for devloop and other hosts. */
export async function handleNotificationRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const { request, path, notifications } = context;
  if (!path.startsWith("/v1/notifications")) return undefined;
  if (!notifications) {
    return json({ ok: false, error: "notifications unavailable" }, 503);
  }
  if (path === "/v1/notifications/settings") {
    if (request.method === "GET") {
      return json({ settings: await notifications.settings() });
    }
    if (request.method === "PUT") {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      try {
        const body = await readJson(request);
        const value =
          body.settings && typeof body.settings === "object"
            ? body.settings
            : body;
        return json({ settings: await notifications.updateSettings(value) });
      } catch (error) {
        if (error instanceof NotificationInputError) {
          return json(
            {
              ok: false,
              error: error.message,
              code: "invalid_notification_settings",
            },
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
  if (path === "/v1/notifications/channels" && request.method === "GET") {
    return json({ channels: notifications.channels() });
  }
  if (path === "/v1/notifications/config") {
    if (!context.notificationConfig) {
      return json(
        { ok: false, error: "notification channel config unavailable" },
        503
      );
    }
    if (request.method === "GET") {
      return json({
        config: redactNotificationChannelConfig(
          await context.notificationConfig.get()
        ),
        fields: NOTIFICATION_CHANNEL_CONFIG_GROUPS,
      });
    }
    if (request.method === "PUT") {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      try {
        const body = await readJson(request);
        const value =
          body.config && typeof body.config === "object" ? body.config : body;
        const current = await context.notificationConfig.get();
        const saved = await context.notificationConfig.set(
          restoreNotificationChannelConfigSecrets(value, current)
        );
        return json({
          config: redactNotificationChannelConfig(saved),
          fields: NOTIFICATION_CHANNEL_CONFIG_GROUPS,
        });
      } catch (error) {
        if (error instanceof NotificationChannelConfigError) {
          return json(
            {
              ok: false,
              error: error.message,
              code: "invalid_notification_channel_config",
            },
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
  if (path === "/v1/notifications/status" && request.method === "GET") {
    return json(await notifications.status());
  }
  if (path === "/v1/notifications/test" && request.method === "POST") {
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
    const body = await readJson(request);
    const targetId =
      typeof body.targetId === "string" ? body.targetId.trim() : "";
    if (!targetId) {
      return json(
        { ok: false, error: "targetId is required", code: "invalid_body" },
        400
      );
    }
    const result = await notifications.test(targetId);
    if (!result.found) {
      return json({ ok: false, error: "unknown notification target" }, 404);
    }
    return json({
      ok: result.attempt.status === "sent",
      targetId: result.targetId,
      status: result.attempt.status,
      ...(result.attempt.status !== "sent"
        ? { reason: redactToolOutput(result.attempt.reason) }
        : {}),
    });
  }
  if (path === "/v1/notifications/send" && request.method === "POST") {
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
    try {
      const body = await readJson(request);
      const result = await notifications.notifyInput(body);
      return json(
        {
          ok: true,
          id: result.id,
          targets: result.targets,
          skipped: result.skipped,
        },
        202
      );
    } catch (error) {
      if (error instanceof NotificationInputError) {
        return json(
          { ok: false, error: error.message, code: "invalid_notification" },
          400
        );
      }
      throw error;
    }
  }
  return json(
    { ok: false, error: "Use GET, PUT, or POST on a notifications route" },
    405
  );
}
