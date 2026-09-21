import { createControlApi } from "./control/service.ts";
import { createPromptApi } from "./conversations/service.ts";
import { join } from "node:path";
import { createActionApi } from "./action/service.ts";
import { createActivityStore } from "./activity/store.ts";
import { createDiagnosisApi } from "./diagnosis/service.ts";
import { createGoalApi } from "./goals/service.ts";
import { createAgentContext } from "./internal/context.ts";
import type { CreateThebeAgentOptions, ThebeAgent } from "./interface.ts";
import { createExtensionApi } from "./extensions/service.ts";
import { createSessionApi } from "./sessions/service.ts";
import { createSubagentApi } from "./subagents/api.ts";
import { createArtifactStore } from "./artifacts/store.ts";

/** Authoritative composition root for the agent layer. */
export function createThebeAgent(options: CreateThebeAgentOptions): ThebeAgent {
  const ctx = createAgentContext(options);
  const extensions = createExtensionApi(ctx);
  const subagents = createSubagentApi(ctx);
  const goals = createGoalApi(ctx, subagents);
  const restoreSessionState = async (thebeSessionId: string): Promise<void> => {
    const meta = await ctx.lookup(thebeSessionId);
    subagents.restoreSubagents(thebeSessionId, meta.subagentRuns ?? []);
    goals.restoreGoal(meta.goalRun);
  };
  const sessions = createSessionApi(ctx, restoreSessionState);
  const prompts = createPromptApi(ctx);
  const activityStore = createActivityStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "activity")
      : undefined,
    now: ctx.now,
  });
  const artifactStore = options.artifactStore ?? createArtifactStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "artifacts")
      : undefined,
    now: ctx.now,
  });
  const diagnosis = createDiagnosisApi({
    now: ctx.now,
    policy: ctx.policy,
    audit: ctx.audit,
    baseTools: ctx.baseTools,
    createSession: sessions.createSession,
    prompt: prompts.prompt,
    activityStore,
    judgment: ctx.judgment,
  });
  const actions = createActionApi({
    now: ctx.now,
    provider: options.provider,
    audit: ctx.audit,
    getDiagnosis: diagnosis.getDiagnosis,
    activityStore,
    artifactStore,
  });
  return {
    runtime: options.runtime,
    workspacePath: ctx.workspacePath,
    ...prompts,
    ...sessions,
    ...goals,
    ...extensions,
    ...subagents,
    ...createControlApi(ctx),
    ...diagnosis,
    ...actions,
    async listArtifacts(query) {
      return artifactStore.list(query);
    },
    async getArtifact(artifactId) {
      return artifactStore.get(artifactId);
    },
    async getArtifactContent(artifactId) {
      return artifactStore.getContent(artifactId);
    },
  };
}
