import {
  SERVICE_API_WRITE_TOOL_NAME,
  SERVICE_ARGUMENT,
} from "../capabilities/service-api.ts";
import { irreversibleReason } from "../security/irreversible.ts";
import type { Trigger } from "../sources/types.ts";
import type { TicketMandate } from "./types.ts";

/** Between the service and the action in a tool name: `download_add` is `add` on `download`. */
const TOOL_NAME_SEPARATOR = "_";

/** `container:write`: the writes that are not irreversible, on the container service. */
export function scopeEntry(service: string): string {
  return `${service}:write`;
}

/**
 * The service a tool acts on: the part of its name before the first underscore (`download_add` acts on
 * `download`, `navidrome_playlist_update` on `navidrome`). The generic `service_write` names its service
 * in the arguments (`service`). A tool with neither (`bash`, `edit`) is on no service, so no Mandate
 * covers it.
 */
export function serviceOfTool(
  toolName: string,
  args?: Record<string, unknown>
): string | undefined {
  if (toolName === SERVICE_API_WRITE_TOOL_NAME) {
    const service = args?.[SERVICE_ARGUMENT];
    return typeof service === "string" && service ? service : undefined;
  }
  const separator = toolName.indexOf(TOOL_NAME_SEPARATOR);
  return separator > 0 ? toolName.slice(0, separator) : undefined;
}

/**
 * The scope a Ticket is accepted with: the person's rule decides whether to take it on, and what it may
 * touch is inferred here from what the event is about, never from what the model says. An event about a
 * container authorises writes on the services that look after containers (the ones whose connection
 * says so; `servicesFor` gives them), minus anything irreversible. With none declared, the kind itself
 * names the service. (Plan item 8.)
 */
export function inferScope(
  triggers: readonly Trigger[],
  servicesFor: (kind: string) => readonly string[] = () => []
): string[] {
  const services = new Set<string>();
  for (const trigger of triggers) {
    const kind = trigger.resource?.kind;
    if (!kind) continue;
    const declared = servicesFor(kind);
    for (const service of declared.length > 0 ? declared : [kind]) {
      services.add(service);
    }
  }
  return [...services].sort().map(scopeEntry);
}

/** A Ticket Eval accepted on its own has no person watching it, so what its Mandate does not cover is refused. */
export function isUnattended(
  mandate: Pick<TicketMandate, "decidedBy"> | undefined
): boolean {
  return mandate?.decidedBy === "eval";
}

/**
 * Whether a Mandate authorises this one call without asking: it is on a service the scope names, and it is
 * not irreversible. Judged per call, with the classifier the gateway uses, so a new write tool on a service
 * is covered with no change here, and a delete is not. Only calls that would otherwise ask reach this.
 */
export function mandateAllows(
  mandate: Pick<TicketMandate, "scope"> | undefined,
  toolName: string,
  args?: unknown
): boolean {
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const service = serviceOfTool(toolName, record);
  if (!service) return false;
  if (!mandate?.scope?.includes(scopeEntry(service))) return false;
  // A generic service call says its HTTP method; a DELETE is never covered.
  const httpMethod =
    toolName === SERVICE_API_WRITE_TOOL_NAME &&
    typeof record.method === "string"
      ? record.method
      : undefined;
  return (
    irreversibleReason({ name: toolName, args: record, httpMethod }) ===
    undefined
  );
}
