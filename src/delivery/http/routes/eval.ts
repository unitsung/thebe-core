import { PolicyError } from "../../../agent/eval/policy-store.ts";
import {
  agentUnavailable,
  quiescedWrite,
  type ThebeHttpContext,
} from "../context.ts";
import { json, readJson } from "../json.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

/**
 * The rules Core weighs events by, and what it decided. The policy is the person's to change; Decisions
 * are Core's record and are read-only here.
 */
export async function handleEvalRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const { path, request } = context;
  const policy = PRODUCT_HTTP_PATH.policy;
  const decisions = PRODUCT_HTTP_PATH.decisions;
  const isPolicy = path === policy;
  const isDecisions = path === decisions || path.startsWith(`${decisions}/`);
  if (!isPolicy && !isDecisions) return undefined;
  if (!context.agent) return agentUnavailable();
  const { agent } = context;

  if (isPolicy) {
    if (request.method === "GET") return json(await agent.getPolicy());
    if (request.method === "PUT") {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      try {
        return json(await agent.setPolicy(await readJson(request)));
      } catch (error) {
        if (error instanceof PolicyError) {
          return json(
            { ok: false, error: error.message, code: "invalid_policy" },
            400
          );
        }
        throw error;
      }
    }
    return json(
      { ok: false, error: "Use GET or PUT", code: "method_not_allowed" },
      405
    );
  }

  const isAcceptDecision =
    context.parts.length === 4 &&
    context.parts[1] === "decisions" &&
    context.parts[3] === "accept";
  if (isAcceptDecision) {
    if (request.method !== "POST") {
      return json(
        {
          ok: false,
          error: "Use POST to accept a Decision",
          code: "method_not_allowed",
        },
        405
      );
    }
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
    const decisionId = context.parts[2];
    if (!decisionId) {
      return json(
        { ok: false, error: "decision not found", code: "not_found" },
        404
      );
    }
    const accepted = await agent.acceptDecision(decisionId);
    return json(accepted, accepted.reused ? 200 : 201);
  }

  const isAttachDecision =
    context.parts.length === 4 &&
    context.parts[1] === "decisions" &&
    context.parts[3] === "attach";
  if (isAttachDecision) {
    if (request.method !== "POST") {
      return json(
        {
          ok: false,
          error: "Use POST to attach a Decision",
          code: "method_not_allowed",
        },
        405
      );
    }
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
    const decisionId = context.parts[2];
    if (!decisionId) {
      return json(
        { ok: false, error: "decision not found", code: "not_found" },
        404
      );
    }
    const input = await readJson(request);
    const attached = await agent.attachDecision({
      decisionId,
      ticketId: typeof input.ticketId === "string" ? input.ticketId.trim() : "",
      ...(typeof input.note === "string" ? { note: input.note } : {}),
    });
    return json(attached, attached.reused ? 200 : 201);
  }

  if (request.method !== "GET") {
    return json(
      {
        ok: false,
        error: "Decisions are read-only",
        code: "method_not_allowed",
      },
      405
    );
  }
  if (path === decisions) {
    const thread = context.url.searchParams.get("thread") ?? undefined;
    const rawLimit = Number(context.url.searchParams.get("limit"));
    const limit =
      Number.isInteger(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, 200)
        : undefined;
    return json({ decisions: await agent.listDecisions({ thread, limit }) });
  }
  const id = context.parts[2];
  const found =
    id && context.parts.length === 3 ? await agent.getDecision(id) : undefined;
  if (!found) {
    return json(
      { ok: false, error: "decision not found", code: "not_found" },
      404
    );
  }
  return json(found);
}
