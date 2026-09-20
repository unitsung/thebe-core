import { PERMISSION_MODES } from "../../../agent/runtime/interface.ts";
import { agentUnavailable, quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, invalidBody } from "../parsing/errors.ts";
import { asMember } from "../parsing/query.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

export async function handleSettingsRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith(PRODUCT_HTTP_PATH.permissionSettings)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { request, agent } = context;
  try {
    if (request.method === "GET") {
      return json({ mode: agent.permissionMode() });
    }
    if (request.method === "PATCH") {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const body = await readJson(request);
      const mode = asMember(body.mode, PERMISSION_MODES);
      if (!mode) {
        return invalidBody(`mode must be ${PERMISSION_MODES.join(", ")}`);
      }
      agent.setPermissionMode(mode);
      return json({ mode: agent.permissionMode() });
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}
