import { hashParameters } from "../audit/audit-log.ts";
import {
  TOOLS_REQUIRING_APPROVAL,
  type PermissionRememberScope,
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
 * allow cannot authorize `rm -rf`. A tool-wide key is only written when the
 * user explicitly chooses the session-wide option (or patches that metadata).
 * Conversation-wide decisions use `*` and are checked after exact and
 * tool-wide rules, so a narrower deny still wins.
 */
export function rememberedPermissionKey(
  request: Pick<PermissionRequest, "toolName" | "args" | "risk">,
  response: "allow" | "deny",
  scope: PermissionRememberScope = "request",
): string {
  if (scope === "conversation") {
    return "*";
  }
  if (scope === "tool") {
    return request.toolName;
  }
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
  if (wide) {
    return wide;
  }
  const conversation = map["*"];
  if (conversation) {
    return conversation;
  }
  return undefined;
}
