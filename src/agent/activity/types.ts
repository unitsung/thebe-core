import type { ActionReceipt, ActionResult, ApprovalRecord, VerificationResult } from "../action/types.ts";
import type { DiagnosisResult, Observation, Recommendation, ResourceRef } from "../diagnosis/types.ts";
import { DIAGNOSIS_ACTION_ID } from "../diagnosis/types.ts";
import {
  CONTAINER_RESTART_ACTION_ID,
  CONTAINER_RESTART_METADATA,
} from "../capabilities/containers.ts";

export const ACTIVITY_KIND_RESTART = CONTAINER_RESTART_ACTION_ID;
export const ACTIVITY_KIND_DIAGNOSE = DIAGNOSIS_ACTION_ID;

export type ActivityKind = typeof ACTIVITY_KIND_RESTART | typeof ACTIVITY_KIND_DIAGNOSE;

export type ActivityGroup = "needs_approval" | "running" | "recent";

export type ActivityStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "rejected"
  | "provider_unavailable"
  | "verification_failed"
  | "completed"
  | "insufficient_data";

export type ActivityDiagnosisSnapshot = {
  code: string;
  title: string;
  summary: string;
  confidence: string;
  tokenUsed: boolean;
};

export type ActivityRecord = {
  id: string;
  kind: ActivityKind;
  actionId: string;
  resource: ResourceRef;
  status: ActivityStatus;
  group: ActivityGroup;
  summary: string;
  createdAt: string;
  updatedAt: string;
  diagnosisRunId?: string;
  receiptId?: string;
  artifactId?: string;
  idempotencyKey: string;
  approval?: ApprovalRecord;
  action?: ActionResult;
  verification?: VerificationResult;
  diagnosis?: ActivityDiagnosisSnapshot;
  observations?: Observation[];
  recommendations?: Recommendation[];
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
  prior?: ActivityRecord,
): ActivityRecord {
  return {
    id: receipt.receiptId,
    kind: ACTIVITY_KIND_RESTART,
    actionId: receipt.actionId,
    resource: receipt.resource,
    status: activityStatusFromReceipt(receipt),
    group: "recent",
    summary: receipt.action.summary,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    diagnosisRunId: receipt.diagnosisRunId ?? prior?.diagnosisRunId,
    receiptId: receipt.receiptId,
    artifactId: receipt.artifactId ?? prior?.artifactId,
    idempotencyKey: receipt.idempotencyKey,
    approval: receipt.approval,
    action: receipt.action,
    verification: receipt.verification,
    diagnosis: prior?.diagnosis,
    observations: prior?.observations,
    recommendations: prior?.recommendations,
  };
}

export function hasRestartRecommendation(item: {
  recommendations?: Recommendation[];
}): boolean {
  return (item.recommendations ?? []).some(
    (rec) => rec.actionId === CONTAINER_RESTART_ACTION_ID && rec.requiresApproval,
  );
}

export function isPendingApproval(record: ActivityRecord): boolean {
  if (record.kind === ACTIVITY_KIND_RESTART && record.status === "pending") return true;
  return record.kind === ACTIVITY_KIND_DIAGNOSE && hasRestartRecommendation(record);
}

export function activityApprovalFromDiagnosis(
  result: DiagnosisResult,
  timestamps: { createdAt: string; updatedAt: string },
  id: string,
): ActivityRecord {
  const rec = (result.recommendations ?? []).find(
    (item) => item.actionId === CONTAINER_RESTART_ACTION_ID && item.requiresApproval,
  );
  return {
    id,
    kind: ACTIVITY_KIND_RESTART,
    actionId: CONTAINER_RESTART_ACTION_ID,
    resource: result.resource,
    status: "pending",
    group: "needs_approval",
    summary: rec?.title ?? `Restart ${result.resource.name ?? result.resource.id}`,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    diagnosisRunId: result.runId,
    idempotencyKey: `approve:${CONTAINER_RESTART_ACTION_ID}:${result.resource.id}:${result.runId}`,
    approval: {
      required: true,
      approved: false,
      source: "missing",
      capability: {
        id: CONTAINER_RESTART_ACTION_ID,
        ...CONTAINER_RESTART_METADATA,
      },
    },
    diagnosis: {
      code: result.diagnosis.code,
      title: result.diagnosis.title,
      summary: result.diagnosis.summary,
      confidence: result.diagnosis.confidence,
      tokenUsed: result.diagnosis.tokenUsed,
    },
    observations: result.observations,
    recommendations: result.recommendations,
  };
}

export function activityFromDiagnosis(
  result: DiagnosisResult,
  timestamps: { createdAt: string; updatedAt: string },
): ActivityRecord {
  const status: ActivityStatus =
    result.status === "completed"
      ? "completed"
      : result.status === "insufficient_data"
        ? "insufficient_data"
        : result.status === "provider_unavailable"
          ? "provider_unavailable"
          : "failed";
  return {
    id: result.runId,
    kind: ACTIVITY_KIND_DIAGNOSE,
    actionId: result.actionId,
    resource: result.resource,
    status,
    group: "recent",
    summary: result.diagnosis.title,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    diagnosisRunId: result.runId,
    idempotencyKey: `diagnose:${result.resource.id}:${result.runId}`,
    diagnosis: {
      code: result.diagnosis.code,
      title: result.diagnosis.title,
      summary: result.diagnosis.summary,
      confidence: result.diagnosis.confidence,
      tokenUsed: result.diagnosis.tokenUsed,
    },
    observations: result.observations,
    recommendations: result.recommendations,
  };
}

export function assignActivityGroups(records: ActivityRecord[]): ActivityRecord[] {
  const restartedDiagnosisIds = new Set(
    records
      .filter(
        (item) =>
          item.kind === ACTIVITY_KIND_RESTART &&
          item.diagnosisRunId &&
          item.status !== "pending",
      )
      .map((item) => item.diagnosisRunId as string),
  );
  return records.map((item) => {
    if (item.kind === ACTIVITY_KIND_DIAGNOSE) {
      const pending =
        hasRestartRecommendation(item) && !restartedDiagnosisIds.has(item.id);
      return { ...item, group: pending ? "needs_approval" : "recent" };
    }
    if (item.status === "pending" || !item.action) {
      return { ...item, group: "needs_approval" };
    }
    return { ...item, group: "recent" };
  });
}

export function idempotencyIndexKey(record: {
  actionId: string;
  resource: { id: string };
  idempotencyKey: string;
}): string {
  return `${record.actionId}:${record.resource.id}:${record.idempotencyKey}`;
}
