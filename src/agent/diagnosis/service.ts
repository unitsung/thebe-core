import { randomUUID } from "node:crypto";
import { ProviderError } from "../capabilities/containers.ts";
import { hashParameters } from "../security/audit/audit-log.ts";
import type { createAuditLog } from "../security/audit/audit-log.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";
import { wrapCustomTools } from "../tools/wrapped-tool.ts";
import type { CustomToolDefinition } from "../runtime/index.ts";
import type { AgentSessionMeta } from "../store.ts";
import type { ThebePromptResult } from "../types.ts";
import type { ActivityStore } from "../activity/store.ts";
import { ACTIVITY_KIND_RESTART } from "../activity/types.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import { deterministicDiagnosis } from "./deterministic.ts";
import {
  asContainerDetail,
  asHostSummary,
  asLogText,
  DIAGNOSIS_LOG_TAIL,
  extractObservations,
  parseToolPayload,
} from "./observations.ts";
import type { JudgmentApi } from "../judgment/service.ts";
import { DIAGNOSIS_WRITE_RECOMMENDATION_SITE } from "../judgment/sites.ts";
import {
  applyWriteRecommendationJudgment,
  judgeWriteRecommendation,
} from "./write-judgment.ts";
import {
  DIAGNOSIS_ACTION_ID,
  type DiagnosisRequest,
  type DiagnosisResult,
  type Recommendation,
  type ResourceRef,
} from "./types.ts";

const MAX_RUNS = 32;
const REASONING_TIMEOUT_MS = 20_000;

type Policy = ReturnType<typeof createPolicyEngine>;
type Audit = ReturnType<typeof createAuditLog>;

export type DiagnosisApi = {
  diagnose(request: DiagnosisRequest): Promise<DiagnosisResult>;
  getDiagnosis(runId: string): Promise<DiagnosisResult | undefined>;
  explainDiagnosis(runId: string, question?: string): Promise<DiagnosisResult>;
};

export function createDiagnosisApi(options: {
  now: () => Date;
  policy: Policy;
  audit?: Audit;
  baseTools: () => CustomToolDefinition[];
  createSession: (init?: {
    title?: string;
    builtinTools?: readonly string[];
    labels?: Record<string, string>;
  }) => Promise<AgentSessionMeta>;
  prompt: (
    input: string,
    options?: { thebeSessionId?: string; nonInteractive?: boolean }
  ) => Promise<ThebePromptResult>;
  activityStore?: ActivityStore;
  artifactStore?: ArtifactStore;
  judgment?: JudgmentApi;
}): DiagnosisApi {
  const runs = new Map<string, DiagnosisResult>();

  async function remember(result: DiagnosisResult): Promise<DiagnosisResult> {
    let stored = result;
    if (options.artifactStore) {
      const content = JSON.stringify(diagnosisArtifactPayload(result));
      if (result.artifactId && options.artifactStore.update) {
        const updated = await options.artifactStore.update(result.artifactId, {
          contentType: "application/json",
          content,
        });
        if (updated) {
          stored = { ...result, artifactId: updated.artifactId };
        } else {
          stored = { ...result, artifactId: undefined };
        }
      }
      if (!stored.artifactId) {
        const artifact = await options.artifactStore.create({
          kind: "diagnosis",
          title: `Diagnosis: ${result.resource.name ?? result.resource.id}`,
          runId: result.runId,
          sessionId: result.sessionId,
          resource: { kind: result.resource.kind, id: result.resource.id },
          contentType: "application/json",
          content,
        });
        stored = { ...result, artifactId: artifact.artifactId };
      }
    }
    runs.set(stored.runId, stored);
    if (runs.size > MAX_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest) runs.delete(oldest);
    }
    const persisted = await options.activityStore?.upsertFromDiagnosis(stored);
    if (persisted?.kind === ACTIVITY_KIND_RESTART) {
      return { ...stored, approvalId: persisted.id };
    }
    return stored;
  }

  async function collect(resource: ResourceRef, observedAt: string) {
    options.policy.beginRun();
    const tools = wrapCustomTools(options.baseTools(), {
      policy: options.policy,
      audit: options.audit,
    });
    const inspect = await invokeNamed(tools, "container.inspect", {
      id: resource.id,
    });
    const logs = await invokeNamed(tools, "container.logs", {
      id: resource.id,
      tail: DIAGNOSIS_LOG_TAIL,
    });
    const summary = await invokeNamed(tools, "container.status_summary", {});
    const unreachable =
      !inspect.ok &&
      !logs.ok &&
      isUnreachableMessage(inspect.error) &&
      isUnreachableMessage(logs.error);
    if (unreachable) {
      throw new ProviderError(
        "UNREACHABLE",
        inspect.error || logs.error || "provider unreachable"
      );
    }
    return extractObservations({
      resource,
      observedAt,
      inspect: inspect.ok ? asContainerDetail(inspect.value) : undefined,
      logs: logs.ok ? asLogText(logs.value) : undefined,
      summary: summary.ok ? asHostSummary(summary.value) : undefined,
      inspectError: inspect.ok ? undefined : inspect.error,
      logsError: logs.ok ? undefined : logs.error,
      summaryError: summary.ok ? undefined : summary.error,
    });
  }

  async function diagnose(request: DiagnosisRequest): Promise<DiagnosisResult> {
    const resource = normalizeResource(request.resource);
    const observedAt = options.now().toISOString();
    const runId = randomUUID();
    if (!resource.id) {
      return remember(
        failedResult(runId, resource, "resource.id is required", "failed")
      );
    }

    let collected: Awaited<ReturnType<typeof collect>>;
    try {
      collected = await collect(resource, observedAt);
    } catch (error) {
      const unavailable = isProviderUnavailable(error);
      return remember(
        failedResult(
          runId,
          resource,
          error instanceof Error ? error.message : String(error),
          unavailable ? "provider_unavailable" : "failed"
        )
      );
    }

    const baseline = deterministicDiagnosis({
      resource,
      observations: collected.observations,
    });
    let diagnosis = baseline.diagnosis;
    let recommendations = baseline.recommendations;
    let sessionId: string | undefined;

    const judgment = await judgeWriteRecommendation({
      judgment: options.judgment,
      resource,
      observations: collected.observations,
      diagnosis: baseline.diagnosis,
    });

    const hasProviderFacts = collected.observations.some(
      (item) => item.kind !== "error"
    );
    const shouldAskModel =
      hasProviderFacts &&
      diagnosis.confidence !== "high" &&
      diagnosis.code !== "insufficient_data";

    if (shouldAskModel) {
      try {
        const reasoned = await reasonWithAgent({
          resource,
          observations: collected.observations,
          fallback: baseline.diagnosis,
          question: request.question,
          createSession: options.createSession,
          prompt: options.prompt,
        });
        diagnosis = reasoned.diagnosis;
        recommendations = mergeRecommendations(
          baseline.recommendations,
          reasoned.recommendations
        );
        sessionId = reasoned.sessionId;
      } catch {
        // Keep deterministic result when the model path fails.
      }
    }

    recommendations = applyWriteRecommendationJudgment({
      code: baseline.diagnosis.code,
      recommendations,
      trace: judgment,
    });

    const result: DiagnosisResult = {
      runId,
      actionId: DIAGNOSIS_ACTION_ID,
      status:
        collected.observations.length === 0 ? "insufficient_data" : "completed",
      resource,
      observations: collected.observations,
      diagnosis,
      recommendations,
      technicalDetails: {
        evidence: collected.evidence,
        toolTranscript: collected.toolTranscript,
        ...(options.judgment?.enabled(DIAGNOSIS_WRITE_RECOMMENDATION_SITE)
          ? { judgment }
          : {}),
      },
      sessionId,
    };
    await options.audit
      ?.append({
        method: DIAGNOSIS_ACTION_ID,
        parameterHash: hashParameters({
          id: resource.id,
          provider: resource.provider,
        }),
        responseBytes: JSON.stringify(result.observations).length,
        budgetConsumed: collected.toolTranscript.length,
        redactionFired: JSON.stringify(result).includes("***REDACTED***"),
        sessionId,
        result: result.status === "completed" ? "ok" : "error",
      })
      .catch(() => {});
    return remember(result);
  }

  return {
    diagnose,
    async getDiagnosis(runId: string) {
      return runs.get(runId);
    },
    async explainDiagnosis(runId: string, question?: string) {
      const existing = runs.get(runId);
      if (!existing) {
        throw new Error(`unknown diagnosis run: ${runId}`);
      }
      if (existing.observations.length === 0) {
        return existing;
      }
      try {
        const reasoned = await reasonWithAgent({
          resource: existing.resource,
          observations: existing.observations,
          fallback: existing.diagnosis,
          question: question ?? "Why did you reach this diagnosis?",
          createSession: options.createSession,
          prompt: options.prompt,
        });
        const next: DiagnosisResult = {
          ...existing,
          diagnosis: {
            ...reasoned.diagnosis,
            tokenUsed: true,
          },
          recommendations: mergeRecommendations(
            existing.recommendations,
            reasoned.recommendations
          ),
          sessionId: reasoned.sessionId ?? existing.sessionId,
        };
        return remember(next);
      } catch (error) {
        return remember({
          ...existing,
          diagnosis: {
            ...existing.diagnosis,
            reasoning: existing.diagnosis.reasoning,
          },
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

function diagnosisArtifactPayload(
  result: DiagnosisResult
): Record<string, unknown> {
  return {
    version: 1,
    runId: result.runId,
    actionId: result.actionId,
    status: result.status,
    resource: result.resource,
    observations: result.observations,
    diagnosis: result.diagnosis,
    recommendations: result.recommendations,
    evidence: result.technicalDetails.evidence,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function invokeNamed(
  tools: CustomToolDefinition[],
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const tool = tools.find((item) => item.name === name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  try {
    const result = await tool.execute("diagnosis", args);
    const text = result.content.map((block) => block.text).join("\n");
    if (result.isError) return { ok: false, error: text || `${name} failed` };
    return { ok: true, value: parseToolPayload(text) };
  } catch (error) {
    if (isProviderUnavailable(error)) throw error;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function reasonWithAgent(input: {
  resource: ResourceRef;
  observations: DiagnosisResult["observations"];
  fallback: DiagnosisResult["diagnosis"];
  question?: string;
  createSession: (init?: {
    title?: string;
    builtinTools?: readonly string[];
    labels?: Record<string, string>;
  }) => Promise<AgentSessionMeta>;
  prompt: (
    text: string,
    options?: { thebeSessionId?: string; nonInteractive?: boolean }
  ) => Promise<ThebePromptResult>;
}): Promise<{
  diagnosis: DiagnosisResult["diagnosis"];
  recommendations: Recommendation[];
  sessionId?: string;
}> {
  const session = await input.createSession({
    title: `diagnose ${input.resource.kind}:${input.resource.id}`,
    builtinTools: [],
    labels: { purpose: "container-diagnosis" },
  });
  const prompt = [
    "Complete a structured container diagnosis.",
    "Use ONLY the Observed Facts JSON. Do not invent facts, secrets, logs, or inspect fields that are not present.",
    "Do not call tools. Reply with JSON only:",
    '{"code":"string","title":"string","summary":"string","confidence":"low|medium|high","reasoning":"string","recommendations":[{"id":"string","title":"string","detail":"string","kind":"read|write","requiresApproval":true}]}',
    "Write recommendations must remain suggestions; this invocation cannot execute restart/stop/delete.",
    input.question ? `User question: ${input.question}` : "",
    "Observed Facts:",
    JSON.stringify(
      input.observations.map((item) => ({
        id: item.id,
        kind: item.kind,
        fact: item.fact,
        source: item.source,
        observedAt: item.observedAt,
        severity: item.severity,
      }))
    ),
  ]
    .filter(Boolean)
    .join("\n");

  const reply = await Promise.race([
    input.prompt(prompt, {
      thebeSessionId: session.thebeSessionId,
      nonInteractive: true,
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("diagnosis reasoning timed out"));
      }, REASONING_TIMEOUT_MS);
      if (typeof timer === "object" && "unref" in timer) {
        (timer as { unref(): void }).unref?.();
      }
    }),
  ]);

  const parsed = parseModelDiagnosis(reply.text);
  if (!parsed) {
    return {
      diagnosis: input.fallback,
      recommendations: [],
      sessionId: session.thebeSessionId,
    };
  }
  return {
    diagnosis: {
      code: parsed.code || input.fallback.code,
      title: parsed.title || input.fallback.title,
      summary: parsed.summary || input.fallback.summary,
      confidence: parsed.confidence ?? input.fallback.confidence,
      reasoning: parsed.reasoning,
      tokenUsed: true,
    },
    recommendations: parsed.recommendations,
    sessionId: session.thebeSessionId,
  };
}

function parseModelDiagnosis(text: string):
  | {
      code?: string;
      title?: string;
      summary?: string;
      confidence?: DiagnosisResult["diagnosis"]["confidence"];
      reasoning?: string;
      recommendations: Recommendation[];
    }
  | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const body = JSON.parse(match[0]) as Record<string, unknown>;
    const confidence =
      body.confidence === "low" ||
      body.confidence === "medium" ||
      body.confidence === "high"
        ? body.confidence
        : undefined;
    const recs = Array.isArray(body.recommendations)
      ? body.recommendations
      : [];
    return {
      code: typeof body.code === "string" ? body.code : undefined,
      title: typeof body.title === "string" ? body.title : undefined,
      summary: typeof body.summary === "string" ? body.summary : undefined,
      confidence,
      reasoning:
        typeof body.reasoning === "string" ? body.reasoning : undefined,
      recommendations: recs.flatMap((item, index) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const kind = row.kind === "write" ? "write" : "read";
        return [
          {
            id: typeof row.id === "string" ? row.id : `rec-model-${index + 1}`,
            title: typeof row.title === "string" ? row.title : "Recommendation",
            detail: typeof row.detail === "string" ? row.detail : "",
            kind,
            requiresApproval:
              kind === "write" ? true : Boolean(row.requiresApproval),
          },
        ];
      }),
    };
  } catch {
    return undefined;
  }
}

function mergeRecommendations(
  base: Recommendation[],
  extra: Recommendation[]
): Recommendation[] {
  const seen = new Set(base.map((item) => item.id));
  const merged = [...base];
  for (const item of extra) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged.slice(0, 8);
}

function normalizeResource(input: ResourceRef): ResourceRef {
  const provider =
    input.provider === "arcane" ||
    input.provider === "portainer" ||
    input.provider === "docker"
      ? input.provider
      : "unknown";
  return {
    kind: "container",
    id: (input.id ?? "").trim(),
    name: input.name?.trim() || undefined,
    provider,
    instanceId: input.instanceId,
    environmentId: input.environmentId,
    endpointId: input.endpointId,
    image: input.image,
    labels: input.labels,
  };
}

function failedResult(
  runId: string,
  resource: ResourceRef,
  error: string,
  status: DiagnosisResult["status"]
): DiagnosisResult {
  return {
    runId,
    actionId: DIAGNOSIS_ACTION_ID,
    status,
    resource,
    observations: [],
    diagnosis: {
      code:
        status === "provider_unavailable"
          ? "provider_unavailable"
          : "insufficient_data",
      title:
        status === "provider_unavailable"
          ? "Container provider unavailable"
          : "Diagnosis failed",
      summary: error,
      confidence: "low",
      tokenUsed: false,
    },
    recommendations: [
      {
        id: "rec-retry",
        title: "Retry after the provider is reachable",
        detail:
          "Native container status on the detail page does not use the model.",
        kind: "read",
        requiresApproval: false,
      },
    ],
    technicalDetails: { evidence: [], toolTranscript: [] },
    error,
  };
}

function isProviderUnavailable(error: unknown): boolean {
  return (
    (error instanceof ProviderError && error.code === "UNREACHABLE") ||
    (error instanceof Error && isUnreachableMessage(error.message))
  );
}

function isUnreachableMessage(message?: string): boolean {
  if (!message) return false;
  return /unreachable|unavailable|econnrefused|enotfound|\bis down\b|provider down/i.test(
    message
  );
}
