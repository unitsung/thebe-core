import {
  PERMISSION_REMEMBER_SCOPES,
  type PermissionRememberScope,
} from "../runtime/index.ts";
import { permissionRisk, summarizeArgs } from "./redaction.ts";
import type { PendingPermission } from "../internal/permission-control.ts";
import { NETWORK_PERMISSION_TOOL } from "./network-policy.ts";

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
  pending: PendingPermission
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
  const network = request.toolName === NETWORK_PERMISSION_TOOL;
  const host = networkHost(request.args) ?? argsSummary;
  return {
    id: request.permissionId,
    sessionId: pending.thebeSessionId ?? "",
    toolName: request.toolName,
    title: network ? `Allow ${host}` : `Approve ${request.toolName}`,
    reason: network
      ? "This sandboxed command wants a host that is not allowed yet. Remember keeps the host for later commands."
      : risk === "high"
        ? "High-risk tool requires confirmation"
        : undefined,
    input,
    argsSummary,
    requestedAt: pending.requestedAt,
    rememberScopes: network ? ["request"] : [...PERMISSION_REMEMBER_SCOPES],
    risk,
  };
}

function networkHost(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const host = (args as { host?: unknown }).host;
  return typeof host === "string" && host.trim() ? host.trim() : undefined;
}
