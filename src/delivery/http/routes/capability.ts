import { CAPABILITY_INVOKE_TYPE_RUN, parseCapabilityInvokeMode } from "../../../agent/capabilities/invoke.ts";
import { toProductCapability } from "../../../agent/extensions/product.ts";
import { agentUnavailable, quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, notFound } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH, PRODUCT_HTTP_SEGMENT } from "../product-paths.ts";
import { capabilityRunEventStream } from "../protocol/sse.ts";

export async function handleCapabilityRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith(PRODUCT_HTTP_PATH.capabilities)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { request, parts, agent } = context;
  try {
    if (request.method === "GET" && parts.length === 2) {
      const capabilities = (await agent.listCapabilities()).map(toProductCapability);
      return json({ capabilities });
    }
    if (
      request.method === "GET" &&
      parts.length === 3 &&
      parts[2] === PRODUCT_HTTP_SEGMENT.runs
    ) {
      return json({ runs: await agent.listCapabilityRuns() });
    }
    if (
      request.method === "GET" &&
      parts.length === 4 &&
      parts[2] === PRODUCT_HTTP_SEGMENT.runs &&
      parts[3]
    ) {
      const run = await agent.getCapabilityRun(parts[3]);
      if (!run) return notFound("capability run not found");
      return json(run);
    }
    if (
      request.method === "GET" &&
      parts.length === 5 &&
      parts[2] === PRODUCT_HTTP_SEGMENT.runs &&
      parts[3] &&
      parts[4] === PRODUCT_HTTP_SEGMENT.log &&
      (request.headers.get("accept") ?? "").includes("text/event-stream")
    ) {
      return await capabilityRunEventStream(agent, parts[3], request);
    }
    if (
      request.method === "POST" &&
      parts.at(-1) === PRODUCT_HTTP_SEGMENT.invoke &&
      parts.length >= 4
    ) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const id = parts.slice(2, -1).join("/");
      const body = await readJson(request);
      const result = await agent.invokeCapability(id, {
        arguments: body.arguments ?? body.args ?? {},
        mode: parseCapabilityInvokeMode(body.mode),
        resource:
          body.resource && typeof body.resource === "object" && !Array.isArray(body.resource)
            ? (body.resource as Record<string, unknown>)
            : undefined,
      });
      return json(result, result.type === CAPABILITY_INVOKE_TYPE_RUN ? 202 : 200);
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}
