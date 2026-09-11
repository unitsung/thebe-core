import { hashParameters } from "../audit/audit-log.ts";
import {
  TOOLS_REQUIRING_APPROVAL,
  type PermissionRequest,
} from "../runtime/types.ts";

export function isHighRiskTool(
  toolName: string,
  risk?: PermissionRequest["risk"],
): boolean {
  return (
    risk === "high" ||
    (TOOLS_REQUIRING_APPROVAL as readonly string[]).includes(toolName)
  );
}

/**
 * Persist key for a remember decision. High-risk tools (bash/write/edit)
 * are scoped to the argument hash for both allow and deny so one `ls`
 * allow cannot authorize `rm -rf`. Tool-wide keys remain for PATCH
 * session-wide deny and for non-approval tools.
 */
export function rememberedPermissionKey(
  request: Pick<PermissionRequest, "toolName" | "args" | "risk">,
  response: "allow" | "deny",
): string {
  if (isHighRiskTool(request.toolName, request.risk)) {
    return `${request.toolName}:${hashParameters(request.args ?? {})}`;
  }
  void response;
  return request.toolName;
}

export function rememberedDecision(
  map: Record<string, "allow" | "deny"> | undefined,
  request: Pick<PermissionRequest, "toolName" | "args" | "risk">,
): "allow" | "deny" | undefined {
  if (!map) {
    return undefined;
  }
  const scoped =
    map[`${request.toolName}:${hashParameters(request.args ?? {})}`];
  if (scoped) {
    return scoped;
  }
  const wide = map[request.toolName];
  if (wide === "deny") {
    return "deny";
  }
  if (wide === "allow" && !isHighRiskTool(request.toolName, request.risk)) {
    return "allow";
  }
  return undefined;
}
