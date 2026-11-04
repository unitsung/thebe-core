import {
  agentUnavailable,
  quiescedWrite,
  type ThebeHttpContext,
} from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, notFound } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

/** The versioned policy. Owner requests only: a /mcp-scoped token never reaches this route. */
export async function handlePolicyRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const { parts, path, request, agent } = context;
  if (
    path !== PRODUCT_HTTP_PATH.policy &&
    !path.startsWith(`${PRODUCT_HTTP_PATH.policy}/`)
  ) {
    return undefined;
  }
  if (!agent) return agentUnavailable();
  try {
    if (parts.length === 2) {
      if (request.method === "GET") return json(await agent.getPolicy());
      if (request.method === "PATCH") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
        return json(await agent.updatePolicy(await readJson(request)));
      }
      return undefined;
    }
    if (parts[2] !== "versions" || request.method !== "GET") return undefined;
    if (parts.length === 3) {
      return json({ versions: await agent.listPolicyVersions() });
    }
    if (parts.length === 4) {
      const raw = parts[3]!;
      if (!/^[1-9]\d{0,8}$/.test(raw))
        return notFound("No such policy version");
      return json(await agent.getPolicyVersion(Number(raw)));
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}
