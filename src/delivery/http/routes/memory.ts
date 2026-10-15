import { parseMemoryOperations } from "../../../agent/tools/memory-tool.ts";
import { agentUnavailable, quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, invalidBody, notFound } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

/** Thebe Memory for its owner: read it, and edit it without the approval the model's tool needs. */
export async function handleMemoryRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const isRead = context.path === PRODUCT_HTTP_PATH.memory;
  const isEdit = context.path === `${PRODUCT_HTTP_PATH.memory}/operations`;
  if (!isRead && !isEdit) return undefined;
  if (!context.agent) return agentUnavailable();
  const { request, agent } = context;
  try {
    if (isRead) {
      return request.method === "GET" ? json(agent.getMemory()) : undefined;
    }
    if (request.method !== "POST") return undefined;
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
    if (!agent.getMemory().enabled) return notFound("memory is not enabled on this Core");
    const parsed = parseMemoryOperations(await readJson(request));
    if (typeof parsed === "string") return invalidBody(parsed);
    const result = await agent.editMemory(parsed.target, parsed.operations);
    if (!result.ok) return invalidBody(result.error ?? "the memory edit was refused");
    return json({ ok: true, memory: result.memory });
  } catch (error) {
    return agentError(error);
  }
}
