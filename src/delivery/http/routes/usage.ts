import {
  agentUnavailable,
  quiescedWrite,
  type ThebeHttpContext,
} from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, invalidBody } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

export async function handleUsageRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const { usageSummary, backgroundBudget, backgroundBudgetSuggestion } =
    PRODUCT_HTTP_PATH;
  if (
    context.path !== usageSummary &&
    context.path !== backgroundBudget &&
    context.path !== backgroundBudgetSuggestion
  ) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { agent, request } = context;

  if (context.path === usageSummary) {
    if (request.method !== "GET") {
      return methodNotAllowed("Use GET for usage summary");
    }
    try {
      return json(await agent.getBackgroundBudgetSummary());
    } catch (error) {
      return agentError(error);
    }
  }

  const blocked = quiescedWrite(context);
  if (blocked) return blocked;

  if (context.path === backgroundBudget) {
    if (request.method !== "PUT") {
      return methodNotAllowed("Use PUT to set the background token budget");
    }
    try {
      const body = await readJson(request);
      if (
        typeof body.dailyTokens !== "number" ||
        !Number.isSafeInteger(body.dailyTokens) ||
        body.dailyTokens < 0
      ) {
        return invalidBody("dailyTokens must be a non-negative integer");
      }
      return json(await agent.setDailyBackgroundTokenBudget(body.dailyTokens));
    } catch (error) {
      return agentError(error);
    }
  }

  if (request.method !== "POST") {
    return methodNotAllowed("Use POST to resolve the budget suggestion");
  }
  try {
    const body = await readJson(request);
    if (body.action !== "accept" && body.action !== "ignore") {
      return invalidBody('action must be "accept" or "ignore"');
    }
    return json(await agent.resolveBackgroundBudgetSuggestion(body.action));
  } catch (error) {
    return agentError(error);
  }
}

function methodNotAllowed(message: string): Response {
  return json({ ok: false, error: message, code: "method_not_allowed" }, 405);
}
