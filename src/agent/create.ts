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
import { createScheduleApi } from "./schedules/service.ts";
import { createReportInbox } from "./reports/report.ts";
import { createUsageApi } from "./usage/service.ts";
import { createPolicyApi } from "./policy/service.ts";
import { createTicketApi } from "./tickets/service.ts";
import { CONTAINER_HEALTH_SOURCE } from "./sources/container-health.ts";
import { createSourceRuntime } from "./sources/runtime.ts";

/** Authoritative composition root for the agent layer. */
export function createThebeAgent(options: CreateThebeAgentOptions): ThebeAgent {
  const ctx = createAgentContext(options);
  const artifactStore =
    options.artifactStore ??
    createArtifactStore({
      dir: options.agentStoreDir
        ? join(options.agentStoreDir, "artifacts")
        : undefined,
      now: ctx.now,
    });
  const extensions = createExtensionApi(ctx, artifactStore);
  const reportInbox = createReportInbox();
  const subagents = createSubagentApi(ctx, artifactStore, reportInbox);
  const goals = createGoalApi(ctx, subagents, artifactStore, reportInbox);
  const restoreSessionState = async (thebeSessionId: string): Promise<void> => {
    const meta = await ctx.lookup(thebeSessionId);
    subagents.restoreSubagents(thebeSessionId, meta.subagentRuns ?? []);
    goals.restoreGoal(meta.goalRun, meta.goalEvents);
  };
  const sessions = createSessionApi(ctx, restoreSessionState);
  const prompts = createPromptApi(ctx);
  const schedules = createScheduleApi({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "schedules")
      : undefined,
    now: ctx.now,
    goals: { ...sessions, ...goals },
    checkWritable: ctx.checkNotQuiesced,
    isQuiesced: () => options.runtime.isQuiesced(),
    timer: options.schedules?.timer,
  });
  const policy = createPolicyApi({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "policy")
      : undefined,
    now: ctx.now,
  });
  const baseStageContext = () => ({
    now: ctx.now(),
    confirmationSessionIds: new Set(
      sessions.listPendingPermissions().map((pending) => pending.sessionId)
    ),
  });
  const tickets = createTicketApi({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "tickets")
      : undefined,
    listGoals: goals.listGoals,
    stageContext: baseStageContext,
  });
  const sources = createSourceRuntime({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "sources")
      : undefined,
    provider: options.provider,
    getSettings: async () =>
      (await policy.getPolicy()).sources[CONTAINER_HEALTH_SOURCE],
    now: ctx.now,
    evaluate: options.sources?.evaluate,
    timer: options.sources?.timer,
    pollIntervalMs: options.sources?.pollIntervalMs,
  });
  schedules.start();
  sources.start();
  ctx.pipelineAdvancer?.start();
  const activityStore = createActivityStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "activity")
      : undefined,
    now: ctx.now,
    onPendingApproval: options.onPendingApproval,
  });
  const diagnosis = createDiagnosisApi({
    now: ctx.now,
    policy: ctx.policy,
    audit: ctx.audit,
    baseTools: ctx.baseTools,
    createSession: sessions.createSession,
    prompt: prompts.prompt,
    activityStore,
    artifactStore,
  });
  const actions = createActionApi({
    now: ctx.now,
    provider: options.provider,
    audit: ctx.audit,
    getDiagnosis: diagnosis.getDiagnosis,
    activityStore,
    artifactStore,
  });
  const usage = createUsageApi({
    now: ctx.now,
    listMetas: ctx.listMetas,
    listGoals: goals.listGoals,
    activityStore,
    openSession: ctx.openSession,
  });
  return {
    runtime: options.runtime,
    workspacePath: ctx.workspacePath,
    ...prompts,
    ...sessions,
    ...goals,
    ...extensions,
    ...subagents,
    ...createControlApi(ctx, artifactStore, {
      executeAction: actions.executeApprovedAction,
    }),
    async activityStageContext() {
      return { ...baseStageContext(), ticketIds: await tickets.ticketIndex() };
    },
    async startGoal({ triggerId, ...input }) {
      if (triggerId) {
        const started = await tickets.goalForTrigger(triggerId);
        if (started) return started;
      }
      const run = await goals.startGoal(input);
      // A goal that is running must not fail to start because its ticket could not be written: the
      // later backfill wraps goals that have none, idempotently by goal id.
      await tickets
        .acceptExplicitGoal({ run, triggerId })
        .catch(() => undefined);
      return run;
    },
    goalForTrigger: tickets.goalForTrigger,
    exclusiveForTrigger: tickets.exclusiveForTrigger,
    listTickets: tickets.listTickets,
    getTicket: tickets.getTicket,
    resolveGoalId: tickets.resolveGoalId,
    ticketIndex: tickets.ticketIndex,
    listTriggers: sources.listRecords,
    sourceHealth: sources.health,
    getUsageSummary: usage.getUsageSummary,
    listSchedules: schedules.listSchedules,
    getSchedule: schedules.getSchedule,
    createSchedule: schedules.createSchedule,
    updateSchedule: schedules.updateSchedule,
    setScheduleEnabled: schedules.setScheduleEnabled,
    setScheduleMode: schedules.setScheduleMode,
    listScheduleObservations: schedules.listScheduleObservations,
    deleteSchedule: schedules.deleteSchedule,
    runSchedule: schedules.runSchedule,
    getPolicy: policy.getPolicy,
    getPolicyVersion: policy.getPolicyVersion,
    listPolicyVersions: policy.listPolicyVersions,
    updatePolicy: policy.updatePolicy,
    async quiesce() {
      ctx.pipelineAdvancer?.stop();
      sources.stop();
      await schedules.stop();
      await options.runtime.quiesce();
    },
    async unquiesce() {
      await options.runtime.unquiesce();
      schedules.start();
      sources.start();
      ctx.pipelineAdvancer?.start();
    },
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
