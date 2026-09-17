import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import type { ResourceRef } from "../../../agent/diagnosis/types.ts";

export async function handleDiagnosisRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith("/v1/diagnosis")) {
    return undefined;
  }
  if (!context.agent) {
    return agentUnavailable();
  }
  const { request, path, parts, agent } = context;
  if (request.method === "POST" && path === "/v1/diagnosis") {
    const body = await readJson(request);
    const resource = asResource(body.resource);
    if (!resource) {
      return json({ ok: false, error: "resource.id is required" }, 400);
    }
    const result = await agent.diagnose({
      resource,
      question: typeof body.question === "string" ? body.question : undefined,
    });
    return json(result, result.status === "provider_unavailable" ? 503 : 200);
  }
  if (parts.length === 3 && parts[0] === "v1" && parts[1] === "diagnosis") {
    const runId = parts[2] ?? "";
    if (request.method === "GET" && runId) {
      const result = await agent.getDiagnosis(runId);
      if (!result) return json({ ok: false, error: "diagnosis run not found" }, 404);
      return json(result);
    }
  }
  if (
    request.method === "POST" &&
    parts.length === 4 &&
    parts[0] === "v1" &&
    parts[1] === "diagnosis" &&
    parts[3] === "why"
  ) {
    const runId = parts[2] ?? "";
    if (!runId) {
      return json({ ok: false, error: "diagnosis run not found" }, 404);
    }
    const body = await readJson(request);
    try {
      const result = await agent.explainDiagnosis(
        runId,
        typeof body.question === "string" ? body.question : undefined,
      );
      return json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ ok: false, error: message }, 404);
    }
  }
  return undefined;
}

function asResource(value: unknown): ResourceRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return undefined;
  const provider =
    row.provider === "arcane" || row.provider === "portainer" ? row.provider : "unknown";
  const labels =
    row.labels && typeof row.labels === "object" && !Array.isArray(row.labels)
      ? Object.fromEntries(
          Object.entries(row.labels as Record<string, unknown>).flatMap(([key, item]) =>
            typeof item === "string" ? [[key, item]] : [],
          ),
        )
      : undefined;
  return {
    kind: "container",
    id: row.id.trim(),
    name: typeof row.name === "string" ? row.name : undefined,
    provider,
    instanceId: typeof row.instanceId === "string" ? row.instanceId : undefined,
    environmentId: typeof row.environmentId === "string" ? row.environmentId : undefined,
    endpointId: typeof row.endpointId === "number" ? row.endpointId : undefined,
    image: typeof row.image === "string" ? row.image : undefined,
    labels,
  };
}
