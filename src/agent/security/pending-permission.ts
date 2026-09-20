import { PERMISSION_REMEMBER_SCOPES, type PermissionRememberScope } from "../runtime/index.ts";
import { permissionRisk, summarizeArgs } from "./redaction.ts";
import type { PendingPermission } from "../internal/permission-control.ts";

export type ProductPendingPermission = {
  id: string;
  sessionId: string;
  toolName: string;
  title: string;
  reason?: string;
  input?: unknown;
  argsSummary?: string;
  requestedAt: string;
  rememberScopes: PermissionRememberScope[];
  risk?: "high" | "standard";
};

export function toProductPendingPermission(
  pending: PendingPermission,
): ProductPendingPermission {
  const request = pending.request;
  const argsSummary = request.argsSummary ?? summarizeArgs(request.args);
  let input: unknown;
  try {
    input = JSON.parse(argsSummary) as unknown;
  } catch {
    input = argsSummary;
  }
  const risk = request.risk ?? permissionRisk(request.toolName);
  return {
    id: request.permissionId,
    sessionId: pending.thebeSessionId ?? "",
    toolName: request.toolName,
    title: `Approve ${request.toolName}`,
    reason: risk === "high" ? "High-risk tool requires confirmation" : undefined,
    input,
    argsSummary,
    requestedAt: pending.requestedAt,
    rememberScopes: [...PERMISSION_REMEMBER_SCOPES],
    risk,
  };
}
