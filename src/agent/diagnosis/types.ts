import type { JudgmentTrace } from "../judgment/types.ts";

export const DIAGNOSIS_ACTION_ID = "container.diagnose" as const;

export type ResourceKind = "container";

export type ResourceProvider = "arcane" | "portainer" | "unknown";

export type ResourceRef = {
  kind: ResourceKind;
  id: string;
  name?: string;
  provider: ResourceProvider;
  instanceId?: string;
  environmentId?: string;
  endpointId?: number;
  image?: string;
  labels?: Record<string, string>;
};

export type ObservationSeverity = "info" | "warning" | "error";

export type ObservationKind =
  | "state"
  | "health"
  | "image"
  | "config"
  | "network"
  | "logs"
  | "host"
  | "error";

export type Observation = {
  id: string;
  kind: ObservationKind;
  fact: string;
  source: string;
  observedAt: string;
  resource: {
    kind: ResourceKind;
    id: string;
    provider: ResourceProvider;
  };
  severity: ObservationSeverity;
};

export type DiagnosisConfidence = "low" | "medium" | "high";

export type DiagnosisFinding = {
  code: string;
  title: string;
  summary: string;
  confidence: DiagnosisConfidence;
  reasoning?: string;
  tokenUsed: boolean;
};

export type RecommendationKind = "read" | "write";

export type Recommendation = {
  id: string;
  title: string;
  detail: string;
  kind: RecommendationKind;
  requiresApproval: boolean;
  actionId?: string;
};

export type TechnicalEvidence = {
  source: string;
  excerpt: string;
  observedAt: string;
};

export type DiagnosisJudgment = JudgmentTrace;

export type ToolTranscriptEntry = {
  tool: string;
  summary: string;
  observedAt: string;
};

export type DiagnosisStatus =
  | "completed"
  | "failed"
  | "provider_unavailable"
  | "insufficient_data";

export type DiagnosisResult = {
  runId: string;
  actionId: typeof DIAGNOSIS_ACTION_ID;
  status: DiagnosisStatus;
  resource: ResourceRef;
  observations: Observation[];
  diagnosis: DiagnosisFinding;
  recommendations: Recommendation[];
  technicalDetails: {
    evidence: TechnicalEvidence[];
    toolTranscript: ToolTranscriptEntry[];
    judgment?: DiagnosisJudgment;
  };
  error?: string;
  sessionId?: string;
  approvalId?: string;
};

export type DiagnosisRequest = {
  resource: ResourceRef;
  question?: string;
};
