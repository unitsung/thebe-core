import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { agentError, notFound } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

/**
 * Tickets, read-only. A ticket is created when work is accepted (today: a goal the owner asks for);
 * there is no route that writes one, so a token or an event cannot make one by hand.
 */
export async function handleTicketRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const { parts, path, request, agent } = context;
  if (
    path !== PRODUCT_HTTP_PATH.tickets &&
    !path.startsWith(`${PRODUCT_HTTP_PATH.tickets}/`)
  ) {
    return undefined;
  }
  if (request.method !== "GET" || parts.length > 3) return undefined;
  if (!agent) return agentUnavailable();
  try {
    if (parts.length === 2) return json({ tickets: await agent.listTickets() });
    let id = parts[2] ?? "";
    try {
      id = decodeURIComponent(id);
    } catch {
      // Keep the raw text; it will not match a ticket.
    }
    const ticket = await agent.getTicket(id);
    return ticket ? json(ticket) : notFound("ticket not found");
  } catch (error) {
    return agentError(error);
  }
}
