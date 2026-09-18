import type { JudgmentApi } from "../judgment/service.ts";
import type { JudgmentAnswer, JudgmentTrace } from "../judgment/types.ts";
import { DIAGNOSIS_WRITE_RECOMMENDATION_SITE } from "../judgment/sites.ts";
import { CONTAINER_RESTART_ACTION_ID } from "../capabilities/containers.ts";
import { restartWriteRecommendation } from "./deterministic.ts";
import type { DiagnosisFinding, Observation, Recommendation, ResourceRef } from "./types.ts";

const WRITE_RECOMMENDATION_NOUL_THRESHOLD = 0.7;

const DETERMINISTIC_RESTART_CODES = new Set([
  "container_exited",
  "container_dead",
  "container_unhealthy",
]);

export async function judgeWriteRecommendation(input: {
  judgment?: JudgmentApi;
  resource: ResourceRef;
  observations: Observation[];
  diagnosis: DiagnosisFinding;
}): Promise<JudgmentTrace> {
  const siteId = DIAGNOSIS_WRITE_RECOMMENDATION_SITE;
  if (!input.judgment || input.observations.length === 0) {
    return { siteId, used: false, path: "traditional" };
  }
  return input.judgment.ask(siteId, {
    resource: {
      kind: input.resource.kind,
      id: input.resource.id,
      name: input.resource.name,
      provider: input.resource.provider,
    },
    diagnosis: {
      code: input.diagnosis.code,
      title: input.diagnosis.title,
      confidence: input.diagnosis.confidence,
    },
    observations: input.observations.map((item) => ({
      kind: item.kind,
      fact: item.fact,
      severity: item.severity,
      source: item.source,
    })),
  });
}

export function applyWriteRecommendationJudgment(input: {
  code: string;
  recommendations: Recommendation[];
  trace: JudgmentTrace;
}): Recommendation[] {
  const noul = noulAnswer(input.trace.answers?.restart_supported);
  if (!input.trace.used || noul === undefined) {
    return input.recommendations;
  }
  if (noul >= WRITE_RECOMMENDATION_NOUL_THRESHOLD) {
    return ensureRestartRecommendation(input.recommendations);
  }
  if (DETERMINISTIC_RESTART_CODES.has(input.code)) {
    return ensureRestartRecommendation(input.recommendations);
  }
  return input.recommendations.filter(
    (item) => !(item.kind === "write" && item.actionId === CONTAINER_RESTART_ACTION_ID),
  );
}

function ensureRestartRecommendation(recommendations: Recommendation[]): Recommendation[] {
  if (
    recommendations.some(
      (item) => item.actionId === CONTAINER_RESTART_ACTION_ID && item.requiresApproval,
    )
  ) {
    return recommendations;
  }
  return [...recommendations, restartWriteRecommendation()];
}

function noulAnswer(answer: JudgmentAnswer | undefined): number | undefined {
  if (!answer || answer.type !== "noul") return undefined;
  return answer.noul;
}
