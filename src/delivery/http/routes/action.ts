import { agentUnavailable, quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import type { ResourceRef } from "../../../agent/diagnosis/types.ts";
import { CONTAINER_RESTART_ACTION_ID } from "../../../agent/capabilities/containers.ts";

export async function handleActionRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith("/v1/action")) {
    return undefined;
  }
  if (!context.agent) {
    return agentUnavailable();
  }
  const { request, path, parts, agent } = context;
  if (request.method === "POST" && path === "/v1/action") {
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
    const body = await readJson(request);
    const resource = asResource(body.resource);
    if (!resource) {
      return json({ ok: false, error: "resource.id is required" }, 400);
    }
    const approval = asObject(body.approval);
    const receipt = await agent.executeApprovedAction({
      actionId:
        typeof body.actionId === "string" ? body.actionId : CONTAINER_RESTART_ACTION_ID,
      resource,
      diagnosisRunId:
        typeof body.diagnosisRunId === "string" ? body.diagnosisRunId : undefined,
      idempotencyKey:
        typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      approval: approval
        ? {
            approved: approval.approved === true,
            approvedAt: typeof approval.approvedAt === "string" ? approval.approvedAt : undefined,
            client: typeof approval.client === "string" ? approval.client : undefined,
          }
        : undefined,
    });
    const status =
      receipt.action.status === "rejected"
        ? 403
        : receipt.action.status === "provider_unavailable"
          ? 503
          : 200;
    return json(receipt, status);
  }
  if (request.method === "GET" && parts.length === 3 && parts[1] === "action") {
    const receiptId = parts[2] ?? "";
    const receipt = await agent.getReceipt(receiptId);
    if (!receipt) return json({ ok: false, error: "receipt not found" }, 404);
    return json(receipt);
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asResource(value: unknown): ResourceRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return undefined;
  const provider =
    row.provider === "arcane" || row.provider === "portainer" ? row.provider : "unknown";
  return {
    kind: "container",
    id: row.id.trim(),
    name: typeof row.name === "string" ? row.name : undefined,
    provider,
    instanceId: typeof row.instanceId === "string" ? row.instanceId : undefined,
    environmentId: typeof row.environmentId === "string" ? row.environmentId : undefined,
    endpointId: typeof row.endpointId === "number" ? row.endpointId : undefined,
    image: typeof row.image === "string" ? row.image : undefined,
  };
}
