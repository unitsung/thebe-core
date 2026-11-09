import {
  agentUnavailable,
  quiescedWrite,
  type ThebeHttpContext,
} from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";
import { PRODUCT_HTTP_SEGMENT } from "../product-paths.ts";

/**
 * Ticket HTTP controls. The Ticket is the durable assignment; the Goal behind it still owns progress,
 * reports, attention and pending permissions.
 */
export async function handleTicketRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const base = PRODUCT_HTTP_PATH.tickets;
  if (context.path !== base && !context.path.startsWith(`${base}/`)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { request, agent } = context;
  try {
    if (context.path === base) {
      if (request.method === "GET") {
        return json({ tickets: await agent.listTickets() });
      }
      if (request.method === "POST") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
        const result = await agent.delegateTicket(await readJson(request));
        return json(result, result.reused ? 200 : 201);
      }
      return methodNotAllowed();
    }

    const id = context.parts[2];
    if (id && context.parts.length === 3) {
      if (request.method !== "GET") return methodNotAllowed();
      const ticket = await agent.getTicket(id);
      if (!ticket) return ticketNotFound();
      return json(ticket);
    }
    if (
      id &&
      context.parts.length === 4 &&
      context.parts[3] === PRODUCT_HTTP_SEGMENT.reply
    ) {
      if (request.method !== "POST") return methodNotAllowed();
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const input = await readJson(request);
      return json(
        await agent.replyTicket({
          ...input,
          ticketId: id,
        })
      );
    }
    return ticketNotFound();
  } catch (error) {
    return agentError(error);
  }
}

function methodNotAllowed(): Response {
  return json(
    { ok: false, error: "method not allowed", code: "method_not_allowed" },
    405
  );
}

function ticketNotFound(): Response {
  return json({ ok: false, error: "ticket not found", code: "not_found" }, 404);
}
