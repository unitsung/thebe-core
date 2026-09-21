export const ARTIFACT_KINDS = [
  "diagnosis",
  "report",
  "resource_list",
  "operation_receipt",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactResourceRef = {
  kind: string;
  id: string;
};

export type AgentArtifact = {
  artifactId: string;
  kind: ArtifactKind;
  title: string;
  sessionId?: string;
  runId?: string;
  resource?: ArtifactResourceRef;
  createdAt: string;
  updatedAt: string;
  contentType: string;
  sizeBytes: number;
};

export type ArtifactContent = {
  artifact: AgentArtifact;
  content: string;
};

export type ArtifactCreateInput = {
  kind: ArtifactKind;
  title: string;
  content: string;
  contentType?: string;
  sessionId?: string;
  runId?: string;
  resource?: ArtifactResourceRef;
};

export type ArtifactQuery = {
  kind?: ArtifactKind;
  sessionId?: string;
  runId?: string;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
};
