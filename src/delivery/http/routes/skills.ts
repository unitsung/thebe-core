import { toProductSkill } from "../../../agent/extensions/product.ts";
import { agentUnavailable, quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, invalidBody, notFound } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

export async function handleSkillRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith(PRODUCT_HTTP_PATH.skills)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { request, parts, agent } = context;
  try {
    if (request.method === "GET" && parts.length === 2) {
      const skills = (await agent.listSkills()).map(toProductSkill);
      return json({ skills });
    }
    const name = parts[2] ? decodeURIComponent(parts[2]) : "";
    if (!name) return undefined;
    if (request.method === "GET" && parts.length === 4 && parts[3] === "content") {
      const skill = await agent.getSkill(name);
      if (!skill?.content) return notFound("skill content not found");
      return json({ name: skill.name, description: skill.description,
        content: skill.content, contentHash: skill.contentHash });
    }
    if (request.method === "GET" && parts.length === 3) {
      const skill = await agent.getSkill(name);
      if (!skill) return notFound("skill not found");
      return json(toProductSkill(skill));
    }
    if (request.method === "PATCH" && parts.length === 3) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") {
        return invalidBody("enabled must be a boolean");
      }
      if (body.enabled) await agent.enableSkill(name);
      else await agent.disableSkill(name);
      const skill = await agent.getSkill(name);
      if (!skill) return notFound("skill not found");
      return json(toProductSkill(skill));
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}
