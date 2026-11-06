import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

/**
 * Tickets, read-only. A Ticket is created by a decision (a person asking, later Eval accepting a Trigger),
 * never by a caller posting one, so there is no write route here.
 */
export async function handleTicketRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const base = PRODUCT_HTTP_PATH.tickets;
  if (context.path !== base && !context.path.startsWith(`${base}/`)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  if (context.request.method !== "GET") {
    return json(
      { ok: false, error: "Tickets are read-only", code: "method_not_allowed" },
      405
    );
  }
  if (context.path === base) {
    return json({ tickets: await context.agent.listTickets() });
  }
  const id = context.parts[2];
  const ticket =
    id && context.parts.length === 3
      ? await context.agent.getTicket(id)
      : undefined;
  if (!ticket) {
    return json(
      { ok: false, error: "ticket not found", code: "not_found" },
      404
    );
  }
  return json(ticket);
}
