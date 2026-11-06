import type { ResourceRef } from "../diagnosis/types.ts";
import type { ContainerCapabilityMetadata } from "../capabilities/containers.ts";
import { CONTAINER_RESTART_ACTION_ID } from "../capabilities/containers.ts";

export { CONTAINER_RESTART_ACTION_ID };

/** `approval.client` of a restart that came in over `/mcp`; the receipt records it as `mcp_client`. */
export const MCP_CLIENT_APPROVAL = "mcp";

export type ActionApprovalInput = {
  approved: boolean;
  approvedAt?: string;
  client?: string;
};

export type ActionRequest = {
  actionId: string;
  resource: ResourceRef;
  diagnosisRunId?: string;
  idempotencyKey?: string;
  approval?: ActionApprovalInput;
};

export type CapabilityPolicy = ContainerCapabilityMetadata & {
  id: typeof CONTAINER_RESTART_ACTION_ID;
};

export type ApprovalRecord = {
  required: true;
  approved: boolean;
  approvedAt?: string;
  source: "on_device" | "mcp_client" | "missing";
  capability: CapabilityPolicy;
};

export type ActionStatus =
  | "succeeded"
  | "failed"
  | "rejected"
  | "provider_unavailable";

export type ActionResult = {
  status: ActionStatus;
  startedAt?: string;
  finishedAt: string;
  summary: string;
};

export type VerificationCheck = {
  id: string;
  ok: boolean;
  expected?: string;
  actual?: string;
  source: string;
  observedAt: string;
  skipped?: boolean;
};

export type VerificationStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "unavailable";

export type VerificationResult = {
  status: VerificationStatus;
  checks: VerificationCheck[];
  explanation?: string;
};

export type ActionReceipt = {
  receiptId: string;
  artifactId?: string;
  actionId: typeof CONTAINER_RESTART_ACTION_ID;
  resource: ResourceRef;
  diagnosisRunId?: string;
  approval: ApprovalRecord;
  action: ActionResult;
  verification: VerificationResult;
  idempotencyKey: string;
  tokenUsed: boolean;
  error?: string;
};
