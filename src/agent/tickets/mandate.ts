import {
  SERVICE_API_WRITE_TOOL_NAME,
  SERVICE_ARGUMENT,
} from "../capabilities/service-api.ts";
import type { Policy } from "../eval/types.ts";
import { irreversibleReason } from "../security/irreversible.ts";
import type { Trigger } from "../sources/types.ts";
import type { TicketMandate } from "./types.ts";

/** Between the service and the action in a tool name: `download_add` is `add` on `download`. */
const TOOL_NAME_SEPARATOR = "_";
const SCOPE_SUFFIX = ":write";

/** `container:write`: the writes that are not irreversible, on the container service. */
export function scopeEntry(service: string): string {
  return `${service}${SCOPE_SUFFIX}`;
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
    for (const service of servicesForKind(kind, servicesFor)) {
      services.add(service);
    }
  }
  return [...services].sort().map(scopeEntry);
}

export type MandateRevalidation =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Whether an Eval-created Mandate still follows from the current Policy and resource wiring. Direct
 * Tickets are the person's explicit request and do not depend on Policy. For an inferred Ticket, its
 * original scope may only be preserved, never widened, and every service in it must still be derivable
 * from the subscribed Thread.
 */
export function revalidateMandate(input: {
  mandate: Pick<
    TicketMandate,
    "decidedBy" | "requester" | "matchedRuleIds" | "scope"
  >;
  subscriptions: readonly string[];
  policy: Pick<Policy, "acceptMode" | "rules">;
  servicesForResource: (kind: string) => readonly string[];
  /** Omit only when the caller has no Source catalogue to compare against. */
  enabledSources?: readonly string[];
}): MandateRevalidation {
  const { mandate, policy } = input;
  if (mandate.decidedBy === "direct") return { allowed: true };
  if (policy.acceptMode !== "auto") {
    return {
      allowed: false,
      reason: `the current Policy no longer accepts work automatically (acceptMode is ${policy.acceptMode})`,
    };
  }
  if (
    input.enabledSources !== undefined &&
    !input.enabledSources.includes(mandate.requester)
  ) {
    return {
      allowed: false,
      reason: `the ${mandate.requester} Source is not enabled`,
    };
  }

  const currentRuleIds = new Set(policy.rules.map((rule) => rule.id));
  const matchedRuleIds = mandate.matchedRuleIds ?? [];
  if (matchedRuleIds.length === 0) {
    return {
      allowed: false,
      reason: "the Ticket has no matched Policy rules to revalidate",
    };
  }
  const missingRuleIds = matchedRuleIds.filter(
    (ruleId) => !currentRuleIds.has(ruleId)
  );
  if (missingRuleIds.length > 0) {
    return {
      allowed: false,
      reason: `the current Policy no longer contains matched rule(s) ${missingRuleIds.join(", ")}`,
    };
  }

  const kinds = [
    ...new Set(
      input.subscriptions
        .map(resourceKindOfThread)
        .filter((kind): kind is string => Boolean(kind))
    ),
  ];
  if (kinds.length === 0) {
    return {
      allowed: false,
      reason:
        "the Ticket has no resource Thread from which to re-infer its scope",
    };
  }
  const availableServices = new Set(
    kinds.flatMap((kind) => servicesForKind(kind, input.servicesForResource))
  );
  const scope = mandate.scope ?? [];
  if (scope.length === 0) {
    return {
      allowed: false,
      reason: "the Ticket has no service scope to preserve",
    };
  }
  for (const entry of scope) {
    if (!entry.endsWith(SCOPE_SUFFIX)) {
      return {
        allowed: false,
        reason: `the Ticket contains an invalid scope entry ${entry}`,
      };
    }
    const service = entry.slice(0, -SCOPE_SUFFIX.length);
    if (!service || !availableServices.has(service)) {
      return {
        allowed: false,
        reason: `the current resource wiring no longer authorizes ${service}`,
      };
    }
  }
  return { allowed: true };
}

function servicesForKind(
  kind: string,
  servicesFor: (kind: string) => readonly string[]
): readonly string[] {
  const declared = servicesFor(kind);
  return declared.length > 0 ? declared : [kind];
}

function resourceKindOfThread(thread: string): string | undefined {
  return /^resource:([^:]+):/.exec(thread)?.[1];
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
  return mandateRefusal(mandate, toolName, args) === undefined;
}

/**
 * Why a Mandate refuses this call, for the executor to report as a blocker. An allowed call has no
 * refusal.
 */
export function mandateRefusal(
  mandate: Pick<TicketMandate, "scope"> | undefined,
  toolName: string,
  args?: unknown
): string | undefined {
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const service = serviceOfTool(toolName, record);
  if (!service) {
    return `${toolName} does not name a service, so this Ticket's Mandate does not authorize it.`;
  }
  if (!mandate?.scope?.includes(scopeEntry(service))) {
    return `${toolName} acts on ${service}, outside this Ticket's Mandate.`;
  }
  // A generic service call says its HTTP method; a DELETE is never covered.
  const httpMethod =
    toolName === SERVICE_API_WRITE_TOOL_NAME &&
    typeof record.method === "string"
      ? record.method
      : undefined;
  const irreversible = irreversibleReason({
    name: toolName,
    args: record,
    httpMethod,
  });
  if (irreversible) {
    return `${toolName} ${irreversible}, so this Ticket's Mandate does not authorize it.`;
  }
  return undefined;
}
