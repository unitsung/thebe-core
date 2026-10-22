import type { SubagentProfile } from "./catalog.ts";
import type { SubagentRun } from "../types.ts";

/** Client-facing Worker. Core internals remain SubagentRun. */
export type ProductWorker = {
  runId: string;
  parentSessionId: string;
  profileName: string;
  task: string;
  status: SubagentRun["status"];
  turns: number;
  maxTurns: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  artifactId?: string;
  responseText?: string;
  activity?: SubagentRun["activity"];
  result?: string;
  error?: string;
};

export type ProductSubagentProfile = {
  name: string;
  description: string;
  scope: SubagentProfile["scope"];
  tools?: string[];
  maxTurns?: number;
};

export function toProductWorker(run: SubagentRun): ProductWorker {
  return {
    runId: run.runId,
    parentSessionId: run.parentSessionId,
    profileName: run.profileName,
    task: run.task,
    status: run.status,
    turns: run.turns,
    maxTurns: run.maxTurns,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    artifactId: run.artifactId,
    responseText: run.responseText,
    activity: run.activity,
    result: run.result,
    error: run.error,
  };
}

export function toProductSubagentProfile(
  profile: SubagentProfile
): ProductSubagentProfile {
  return {
    name: profile.name,
    description: profile.description,
    scope: profile.scope,
    tools: profile.tools,
    maxTurns: profile.maxTurns,
  };
}
