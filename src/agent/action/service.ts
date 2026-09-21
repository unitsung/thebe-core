import { randomUUID } from "node:crypto";
import {
  CONTAINER_RESTART_ACTION_ID,
  CONTAINER_RESTART_METADATA,
  ProviderError,
  type ContainerInfoProvider,
} from "../capabilities/containers.ts";
import { hashParameters } from "../security/audit/audit-log.ts";
import type { createAuditLog } from "../security/audit/audit-log.ts";
import type { DiagnosisResult } from "../diagnosis/types.ts";
import { verifyRestart, type ProbeHealth } from "./verify.ts";
import type { ActivityStore } from "../activity/store.ts";
import type { ActivityGroup, ActivityRecord } from "../activity/types.ts";
import { idempotencyIndexKey } from "../activity/types.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type {
  ActionReceipt,
  ActionRequest,
  ActionResult,
  ApprovalRecord,
} from "./types.ts";

const MAX_RECEIPTS = 32;

export type ActionApi = {
  executeApprovedAction(request: ActionRequest): Promise<ActionReceipt>;
  getReceipt(receiptId: string): Promise<ActionReceipt | undefined>;
  listActivity(group?: ActivityGroup): Promise<ActivityRecord[]>;
  getActivity(id: string): Promise<ActivityRecord | undefined>;
  denyActivity(id: string): Promise<boolean>;
};

export function createActionApi(options: {
  now: () => Date;
  provider: ContainerInfoProvider;
  audit?: Audit;
  getDiagnosis?: (runId: string) => Promise<DiagnosisResult | undefined>;
  probe?: ProbeHealth;
  explainVerification?: (facts: string) => Promise<string | undefined>;
  activityStore?: ActivityStore;
  artifactStore?: ArtifactStore;
}): ActionApi {
  const receipts = new Map<string, ActionReceipt>();
  const byIdempotency = new Map<string, string>();

  async function remember(receipt: ActionReceipt): Promise<ActionReceipt> {
    let stored = receipt;
    if (options.artifactStore && !receipt.artifactId) {
      const artifact = await options.artifactStore.create({
        kind: "operation_receipt",
        title: `Operation receipt: ${receipt.resource.name ?? receipt.resource.id}`,
        runId: receipt.receiptId,
        resource: { kind: receipt.resource.kind, id: receipt.resource.id },
        contentType: "application/json",
        content: JSON.stringify(receipt),
      });
      stored = { ...receipt, artifactId: artifact.artifactId };
    }
    receipts.set(stored.receiptId, stored);
    byIdempotency.set(idempotencyKey(stored), stored.receiptId);
    if (receipts.size > MAX_RECEIPTS) {
      const oldest = receipts.keys().next().value;
      if (oldest) receipts.delete(oldest);
    }
    await options.activityStore?.upsertFromReceipt(stored);
    return stored;
  }

  return {
    async getReceipt(receiptId: string) {
      const live = receipts.get(receiptId);
      if (live) return live;
      const persisted = await options.activityStore?.get(receiptId);
      return persisted ? receiptFromActivity(persisted) : undefined;
    },
    async listActivity(group?: ActivityGroup) {
      return options.activityStore?.list(group) ?? [];
    },
    async getActivity(id: string) {
      return options.activityStore?.get(id);
    },
    async denyActivity(id: string) {
      return options.activityStore?.removePending(id) ?? false;
    },
    async executeApprovedAction(request: ActionRequest): Promise<ActionReceipt> {
      const finishedAt = options.now().toISOString();
      const resource = request.resource;
      const idempotency =
        request.idempotencyKey?.trim() ||
        `auto:${resource.id}:${CONTAINER_RESTART_ACTION_ID}`;
      const key = `${CONTAINER_RESTART_ACTION_ID}:${resource.id}:${idempotency}`;
      const existingId = byIdempotency.get(key);
      if (existingId) {
        const existing = receipts.get(existingId);
        if (existing) return existing;
      }
      const persisted = await options.activityStore?.getByIdempotency(key);
      if (persisted) {
        const existing = receiptFromActivity(persisted);
        receipts.set(existing.receiptId, existing);
        byIdempotency.set(key, existing.receiptId);
        return existing;
      }

      const capability = {
        id: CONTAINER_RESTART_ACTION_ID,
        ...CONTAINER_RESTART_METADATA,
      } as const;
      const approval: ApprovalRecord = {
        required: true,
        approved: request.approval?.approved === true,
        approvedAt: request.approval?.approvedAt,
        source: request.approval?.approved === true ? "on_device" : "missing",
        capability,
      };

      const receiptId =
        (request.diagnosisRunId
          ? (await options.activityStore?.findPendingForDiagnosis(request.diagnosisRunId))?.id
          : undefined) ?? randomUUID();

      if (request.actionId && request.actionId !== CONTAINER_RESTART_ACTION_ID) {
        return await remember(
          receipt({
            receiptId,
            resource,
            diagnosisRunId: request.diagnosisRunId,
            approval,
            idempotencyKey: idempotency,
            action: {
              status: "rejected",
              finishedAt,
              summary: `Unsupported action: ${request.actionId}`,
            },
            error: "unsupported_action",
          }),
        );
      }

      if (capability.approval === "required" && !approval.approved) {
        return await remember(
          receipt({
            receiptId,
            resource,
            diagnosisRunId: request.diagnosisRunId,
            approval,
            idempotencyKey: idempotency,
            action: {
              status: "rejected",
              finishedAt,
              summary: "container.restart was not approved on device.",
            },
            error: "approval_required",
          }),
        );
      }

      if (typeof options.provider.restartContainer !== "function") {
        return await remember(
          receipt({
            receiptId,
            resource,
            diagnosisRunId: request.diagnosisRunId,
            approval,
            idempotencyKey: idempotency,
            action: {
              status: "failed",
              finishedAt,
              summary: "Container provider does not implement restart.",
            },
            error: "restart_unsupported",
          }),
        );
      }

      const startedAt = options.now().toISOString();
      let action: ActionResult;
      try {
        await options.provider.restartContainer(resource.id);
        action = {
          status: "succeeded",
          startedAt,
          finishedAt: options.now().toISOString(),
          summary: `Restarted ${resource.name ?? resource.id}.`,
        };
      } catch (error) {
        const unavailable = error instanceof ProviderError && error.code === "UNREACHABLE";
        action = {
          status: unavailable ? "provider_unavailable" : "failed",
          startedAt,
          finishedAt: options.now().toISOString(),
          summary: error instanceof Error ? error.message : String(error),
        };
        const failed = receipt({
          receiptId,
          resource,
          diagnosisRunId: request.diagnosisRunId,
          approval,
          idempotencyKey: idempotency,
          action,
          error: action.summary,
        });
        await auditWrite(options.audit, failed);
        return await remember(failed);
      }

      const verification = await verifyRestart({
        provider: options.provider,
        resource,
        now: options.now,
        probe: options.probe,
      });
      let tokenUsed = false;
      if (options.explainVerification) {
        try {
          const facts = JSON.stringify({
            action: { status: action.status, summary: action.summary },
            verification: {
              status: verification.status,
              checks: verification.checks,
            },
          });
          const explanation = await options.explainVerification(facts);
          if (explanation) {
            verification.explanation = explanation;
            tokenUsed = true;
          }
        } catch {
          // Receipt stays deterministic if explanation fails.
        }
      }

      const done = receipt({
        receiptId,
        resource,
        diagnosisRunId: request.diagnosisRunId,
        approval,
        idempotencyKey: idempotency,
        action,
        verification,
        tokenUsed,
      });
      await auditWrite(options.audit, done);
      return await remember(done);
    },
  };
}

function receipt(input: {
  receiptId?: string;
  resource: ActionReceipt["resource"];
  diagnosisRunId?: string;
  approval: ApprovalRecord;
  idempotencyKey: string;
  action: ActionResult;
  verification?: ActionReceipt["verification"];
  tokenUsed?: boolean;
  error?: string;
}): ActionReceipt {
  return {
    receiptId: input.receiptId ?? randomUUID(),
    actionId: CONTAINER_RESTART_ACTION_ID,
    resource: input.resource,
    diagnosisRunId: input.diagnosisRunId,
    approval: input.approval,
    action: input.action,
    verification: input.verification ?? {
      status: input.action.status === "rejected" ? "skipped" : "unavailable",
      checks: [],
    },
    idempotencyKey: input.idempotencyKey,
    tokenUsed: input.tokenUsed ?? false,
    error: input.error,
  };
}

function idempotencyKey(receipt: ActionReceipt): string {
  return idempotencyIndexKey(receipt);
}

function receiptFromActivity(activity: ActivityRecord): ActionReceipt {
  if (!activity.receiptId || !activity.approval || !activity.action || !activity.verification) {
    throw new Error("activity is not a restart receipt");
  }
  return {
    receiptId: activity.receiptId,
    actionId: CONTAINER_RESTART_ACTION_ID,
    resource: activity.resource,
    diagnosisRunId: activity.diagnosisRunId,
    artifactId: activity.artifactId,
    approval: activity.approval,
    action: activity.action,
    verification: activity.verification,
    idempotencyKey: activity.idempotencyKey,
    tokenUsed: false,
  };
}

type Audit = ReturnType<typeof createAuditLog>;

async function auditWrite(audit: Audit | undefined, receipt: ActionReceipt): Promise<void> {
  await audit
    ?.append({
      method: CONTAINER_RESTART_ACTION_ID,
      parameterHash: hashParameters({
        id: receipt.resource.id,
        approved: receipt.approval.approved,
      }),
      responseBytes: JSON.stringify(receipt.verification).length,
      budgetConsumed: 1,
      redactionFired: false,
      result: receipt.action.status === "succeeded" ? "ok" : "error",
    })
    .catch(() => {});
}
