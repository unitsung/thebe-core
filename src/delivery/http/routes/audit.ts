import { AUDIT_RESULTS } from "../../../agent/security/audit/audit-log.ts";
import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { agentError, invalidBody, notFound } from "../parsing/errors.ts";
import { asMember, parseLimit } from "../parsing/query.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

export async function handleAuditRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith(PRODUCT_HTTP_PATH.audit)) return undefined;
  if (!context.agent) return agentUnavailable();
  if (context.request.method !== "GET") return undefined;

  try {
    if (context.parts.length === 3 && context.parts[1] === "audit" && context.parts[2]) {
      const record = await context.agent.getAudit(decodeURIComponent(context.parts[2]));
      return record ? json(record) : notFound("audit record not found");
    }
    if (context.path !== PRODUCT_HTTP_PATH.audit) return undefined;

    const rawLimit = context.url.searchParams.get("limit");
    const parsedLimit = rawLimit === null ? undefined : parseLimit(rawLimit);
    if (parsedLimit && !parsedLimit.ok) return invalidBody(parsedLimit.error);

    const rawCursor = context.url.searchParams.get("cursor");
    let cursor: number | undefined;
    if (rawCursor !== null && rawCursor !== "") {
      const parsed = Number(rawCursor);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return invalidBody("cursor must be a non-negative integer");
      }
      cursor = parsed;
    }

    const rawResult = context.url.searchParams.get("result");
    const result = asMember(rawResult, AUDIT_RESULTS);
    if (rawResult !== null && !result) {
      return invalidBody(`result must be ${AUDIT_RESULTS.join(", ")}`);
    }

    return json(await context.agent.listAudit({
      limit: parsedLimit?.ok ? parsedLimit.limit : undefined,
      cursor,
      sessionId: context.url.searchParams.get("sessionId") || undefined,
      method: context.url.searchParams.get("method") || undefined,
      result,
    }));
  } catch (error) {
    return agentError(error);
  }
}
