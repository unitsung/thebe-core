import type { ActionReceipt, ActionResult, ApprovalRecord, VerificationResult } from "../action/types.ts";
import type { ResourceRef } from "../diagnosis/types.ts";

export const ACTIVITY_KIND_RESTART = "container.restart" as const;

export type ActivityKind = typeof ACTIVITY_KIND_RESTART;

export type ActivityStatus =
  | "succeeded"
  | "failed"
  | "rejected"
  | "provider_unavailable"
  | "verification_failed";

export type ActivityRecord = {
  id: string;
  kind: ActivityKind;
  actionId: typeof ACTIVITY_KIND_RESTART;
  resource: ResourceRef;
  status: ActivityStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
  diagnosisRunId?: string;
  receiptId: string;
  idempotencyKey: string;
  approval: ApprovalRecord;
  action: ActionResult;
  verification: VerificationResult;
};

export function activityStatusFromReceipt(receipt: ActionReceipt): ActivityStatus {
  if (receipt.action.status === "rejected") return "rejected";
  if (receipt.action.status === "provider_unavailable") return "provider_unavailable";
  if (receipt.action.status === "failed") return "failed";
  if (receipt.verification.status === "failed") return "verification_failed";
  return "succeeded";
}

export function activityFromReceipt(
  receipt: ActionReceipt,
  timestamps: { createdAt: string; updatedAt: string },
): ActivityRecord {
  const status = activityStatusFromReceipt(receipt);
  return {
    id: receipt.receiptId,
    kind: ACTIVITY_KIND_RESTART,
    actionId: receipt.actionId,
    resource: receipt.resource,
    status,
    summary: receipt.action.summary,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    diagnosisRunId: receipt.diagnosisRunId,
    receiptId: receipt.receiptId,
    idempotencyKey: receipt.idempotencyKey,
    approval: receipt.approval,
    action: receipt.action,
    verification: receipt.verification,
  };
}

export function idempotencyIndexKey(record: {
  actionId: string;
  resource: { id: string };
  idempotencyKey: string;
}): string {
  return `${record.actionId}:${record.resource.id}:${record.idempotencyKey}`;
}
