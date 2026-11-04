import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { agentError, invalidBody } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

function intParam(value: string | null): number | undefined | "invalid" {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : "invalid";
}

/** Read-only usage and effect summary, computed on demand and never stored. */
export async function handleUsageRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  if (context.path !== PRODUCT_HTTP_PATH.usageSummary) return undefined;
  if (context.request.method !== "GET") return undefined;
  if (!context.agent) return agentUnavailable();
  const params = context.url.searchParams;
  const days = intParam(params.get("days"));
  const utcOffsetMinutes = intParam(params.get("utcOffsetMinutes"));
  if (days === "invalid") return invalidBody("days must be an integer");
  if (utcOffsetMinutes === "invalid") {
    return invalidBody("utcOffsetMinutes must be an integer");
  }
  try {
    return json(
      await context.agent.getUsageSummary({
        from: params.get("from") || undefined,
        to: params.get("to") || undefined,
        days,
        utcOffsetMinutes,
      })
    );
  } catch (error) {
    return agentError(error);
  }
}
