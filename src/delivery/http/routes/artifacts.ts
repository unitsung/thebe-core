import {
  ARTIFACT_KINDS,
  type ArtifactQuery,
} from "../../../agent/artifacts/types.ts";
import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { agentError, invalidBody, notFound } from "../parsing/errors.ts";
import { asMember } from "../parsing/query.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

export async function handleArtifactRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith(PRODUCT_HTTP_PATH.artifacts)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();

  try {
    if (context.request.method !== "GET") return undefined;
    if (context.path === PRODUCT_HTTP_PATH.artifacts) {
      const query = parseQuery(context);
      if (!query.ok) return invalidBody(query.error);
      return json({ artifacts: await context.agent.listArtifacts(query.value) });
    }

    if (context.parts.length === 4 && context.parts[1] === "artifacts" && context.parts[3] === "content") {
      const artifactId = decodeURIComponent(context.parts[2] ?? "");
      const content = await context.agent.getArtifactContent(artifactId);
      return content ? json(content) : notFound("artifact not found");
    }

    if (context.parts.length === 3 && context.parts[1] === "artifacts") {
      const artifactId = decodeURIComponent(context.parts[2] ?? "");
      const artifact = await context.agent.getArtifact(artifactId);
      return artifact ? json(artifact) : notFound("artifact not found");
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}

function parseQuery(
  context: ThebeHttpContext,
): { ok: true; value: ArtifactQuery } | { ok: false; error: string } {
  const rawKind = context.url.searchParams.get("kind");
  const kind = asMember(rawKind, ARTIFACT_KINDS);
  if (rawKind !== null && !kind) {
    return { ok: false, error: `kind must be ${ARTIFACT_KINDS.join(", ")}` };
  }

  const rawLimit = context.url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit <= 0) {
      return { ok: false, error: "limit must be a positive integer" };
    }
  }

  return {
    ok: true,
    value: {
      kind,
      sessionId: context.url.searchParams.get("sessionId") || undefined,
      runId: context.url.searchParams.get("runId") || undefined,
      createdAfter: context.url.searchParams.get("createdAfter") || undefined,
      createdBefore: context.url.searchParams.get("createdBefore") || undefined,
      limit,
    },
  };
}
