import { toProductEnabledResource } from "../../../agent/extensions/product.ts";
import {
  ENABLED_RESOURCE_KINDS,
  type EnabledResource,
} from "../../../agent/runtime/interface.ts";
import { agentUnavailable, quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, invalidBody, notFound } from "../parsing/errors.ts";
import { asMember } from "../parsing/query.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

export async function handleResourceRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith(PRODUCT_HTTP_PATH.enabledResources)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { request, parts, agent } = context;
  try {
    if (request.method === "GET" && parts.length === 3) {
      return json({
        resources: agent.enabledResources().map(toProductEnabledResource),
      });
    }
    if (
      request.method === "POST" &&
      parts.length === 4 &&
      parts[3] === "artifact"
    ) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      return json(await agent.createEnabledResourceArtifact());
    }
    const id = parts[3] ? decodeURIComponent(parts[3]) : "";
    if (!id || parts.length !== 4) return undefined;
    if (request.method === "PUT") {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const body = await readJson(request);
      const kind = asMember(body.kind, ENABLED_RESOURCE_KINDS);
      const version = typeof body.version === "string" ? body.version.trim() : "";
      const source = typeof body.source === "string" ? body.source.trim() : "";
      if (!kind || !version || !source) {
        return invalidBody("kind, version, and source are required");
      }
      const stored = await agent.putEnabledResource({
        identity: id,
        kind,
        version,
        source,
      } satisfies EnabledResource);
      return json(toProductEnabledResource(stored));
    }
    if (request.method === "DELETE") {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const removed = await agent.removeEnabledResource(id);
      if (!removed) return notFound("resource not found");
      return json({ ok: true });
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}
