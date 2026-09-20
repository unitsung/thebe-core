import {
  PERMISSION_REMEMBER_SCOPES,
  PERMISSION_RESPONSES,
  type PermissionRememberScope,
} from "../../../agent/runtime/interface.ts";
import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, notFound } from "../parsing/errors.ts";
import { asMember } from "../parsing/query.ts";
import { PRODUCT_HTTP_PATH, PRODUCT_HTTP_SEGMENT } from "../product-paths.ts";

export async function handlePermissionRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith(PRODUCT_HTTP_PATH.permissions)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { request, parts, agent } = context;
  try {
    if (request.method === "GET" && parts.length === 2) {
      return json({ permissions: agent.listPendingPermissions() });
    }
    const id = parts[2];
    if (!id) return undefined;
    if (request.method === "GET" && parts.length === 3) {
      const pending = agent.getPendingPermission(id);
      if (!pending) return notFound("permission not found");
      return json(pending);
    }
    if (
      request.method === "POST" &&
      parts.length === 4 &&
      parts[3] === PRODUCT_HTTP_SEGMENT.resolve
    ) {
      const body = await readJson(request);
      const response = asMember(body.response, PERMISSION_RESPONSES);
      if (!response) {
        return json({ ok: false, error: "response must be 'allow' or 'deny'" }, 400);
      }
      await agent.resolvePendingPermission(id, {
        response,
        remember: Boolean(body.remember),
        rememberScope: asMember(body.rememberScope, PERMISSION_REMEMBER_SCOPES) ??
          defaultRememberScope(),
      });
      return json({ ok: true });
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}

function defaultRememberScope(): PermissionRememberScope {
  return PERMISSION_REMEMBER_SCOPES[0];
}
