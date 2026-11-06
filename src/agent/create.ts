import { createControlApi } from "./control/service.ts";
import { createPromptApi } from "./conversations/service.ts";
import { join } from "node:path";
import { createActionApi } from "./action/service.ts";
import { key } from "./tickets/ids.ts";
import { createTicketStore } from "./tickets/store.ts";
import { createContainerHealthSource } from "./sources/container-health.ts";
import { createSourceRunner } from "./sources/runner.ts";
import { createTriggerStore } from "./sources/store.ts";
import { createActivityStore } from "./activity/store.ts";
import { createDiagnosisApi } from "./diagnosis/service.ts";
import { createGoalApi } from "./goals/service.ts";
import { createAgentContext } from "./internal/context.ts";
import type { CreateThebeAgentOptions, ThebeAgent } from "./interface.ts";
import { createExtensionApi } from "./extensions/service.ts";
import { createSessionApi } from "./sessions/service.ts";
import { createSubagentApi } from "./subagents/api.ts";
import { createGoalReportInbox } from "./goals/report.ts";
import { createArtifactStore } from "./artifacts/store.ts";
import { createScheduleApi } from "./schedules/service.ts";

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
  const reportInbox = createGoalReportInbox(ctx.now);
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
  });
  schedules.start();
  ctx.pipelineAdvancer?.start();
  const activityStore = createActivityStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "activity")
      : undefined,
    now: ctx.now,
    onPendingApproval: options.onPendingApproval,
  });
  const ticketStore = createTicketStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "tickets")
      : undefined,
  });
  const triggerStore = createTriggerStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "triggers")
      : undefined,
  });
  const sourceRunner = createSourceRunner({
    sources: options.sources?.containerHealth
      ? [
          createContainerHealthSource({
            provider: options.provider,
            now: ctx.now,
          }),
        ]
      : [],
    store: triggerStore,
    intervalMs: options.sources?.intervalMs,
    onError: () => {
      // A Source that cannot be read this time (for example Docker is down) is tried again next tick.
    },
  });
  sourceRunner.start();
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
    async listTriggers(query) {
      return triggerStore.list(query);
    },
    async listTickets() {
      return ticketStore.list();
    },
    async getTicket(id) {
      return ticketStore.get(id);
    },
    async getTicketForGoal(goalId) {
      return ticketStore.getByGoal(goalId);
    },
    async recordGoalTicket(run) {
      // The person asked for this task: a direct Decision, so Eval does not weigh it.
      return ticketStore.recordDirect({
        thread: `chat:${run.thebeSessionId}`,
        triggerId: key("trigger", "chat", "goal-start", run.thebeSessionId),
        kind: "goal-start",
        at: run.createdAt,
        title: run.goal.slice(0, 120),
        requester: "chat",
        goalId: run.thebeSessionId,
        sessionIds: [run.thebeSessionId],
      });
    },
    listSchedules: schedules.listSchedules,
    getSchedule: schedules.getSchedule,
    createSchedule: schedules.createSchedule,
    updateSchedule: schedules.updateSchedule,
    setScheduleEnabled: schedules.setScheduleEnabled,
    deleteSchedule: schedules.deleteSchedule,
    runSchedule: schedules.runSchedule,
    async quiesce() {
      sourceRunner.stop();
      ctx.pipelineAdvancer?.stop();
      await schedules.stop();
      await options.runtime.quiesce();
    },
    async unquiesce() {
      await options.runtime.unquiesce();
      schedules.start();
      sourceRunner.start();
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
