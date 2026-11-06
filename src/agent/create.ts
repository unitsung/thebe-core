import { createControlApi } from "./control/service.ts";
import { createPromptApi } from "./conversations/service.ts";
import { join } from "node:path";
import { createActionApi } from "./action/service.ts";
import { key } from "./tickets/ids.ts";
import { createTicketStore } from "./tickets/store.ts";
import { createContainerHealthSource } from "./sources/container-health.ts";
import { createSourceRunner } from "./sources/runner.ts";
import { createTriggerStore } from "./sources/store.ts";
import { createDecisionStore } from "./eval/decision-store.ts";
import { createPolicyStore } from "./eval/policy-store.ts";
import type { Policy } from "./eval/types.ts";
import { createEvalService, DEFAULT_BACKLOG_AGE_MS } from "./eval/service.ts";
import { executorTask } from "./eval/executor-task.ts";
import { ticketIdFor } from "./tickets/ids.ts";
import { inferScope } from "./tickets/mandate.ts";
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
  const policyStore = createPolicyStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "eval")
      : undefined,
    now: ctx.now,
  });
  const decisionStore = createDecisionStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "eval", "decisions")
      : undefined,
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
  // A Ticket's executor writes under its Mandate, found from the Goal session it runs in, and a restart it
  // makes goes through the same approved-action path a person's approval reaches.
  ctx.setMandateLookup(
    async (thebeSessionId) =>
      (await ticketStore.getByGoal(thebeSessionId))?.mandate
  );
  const evalService = createEvalService({
    policy: policyStore,
    decisions: decisionStore,
    sources: options.sources?.containerHealth ? "container-health" : "",
    maxPerHour: options.evalMaxPerHour,
    threadTickets: async (thread) => {
      // The work taken on for this thread that the Eval could still be looking at: nothing older than the
      // oldest event it weighs.
      const since = ctx.now().getTime() - DEFAULT_BACKLOG_AGE_MS;
      const rows = (await ticketStore.list()).filter(
        (ticket) =>
          ticket.subscriptions.includes(thread) &&
          Date.parse(ticket.createdAt) >= since
      );
      return rows.map((ticket) => ({
        title: ticket.title,
        at: ticket.createdAt,
        state:
          (ticket.links.legacyGoalId
            ? goals.getGoal(ticket.links.legacyGoalId)?.status
            : undefined) ?? "unknown",
      }));
    },
    accept: async (input) => {
      const ticketId = ticketIdFor(input.evalId);
      // Made again after a crash: the same Eval is the same Ticket, and its Goal already started.
      const existing = await ticketStore.get(ticketId);
      if (existing?.links.legacyGoalId) {
        return { ticketId, goalId: existing.links.legacyGoalId };
      }
      const intent = input.assessment.intent ?? `Handle ${input.thread}`;
      const scope = inferScope(input.triggers, (kind) =>
        (options.serviceAPIProviders ?? [])
          .filter((service) => service.resourceKinds?.includes(kind))
          .map((service) => service.id)
      );
      // The Goal's session exists first and the Ticket is made before the executor runs: the executor's
      // writes are judged by the Ticket's Mandate, found from this session.
      const session = await sessions.createSession({
        title: intent,
        labels: { kind: "goal", ticketId },
      });
      await ticketStore.recordAccepted({
        evalId: input.evalId,
        decisionId: input.decisionId,
        thread: input.thread,
        at: input.at,
        title: intent,
        // Whoever saw the event is who asked.
        requester: input.triggers[0]?.source ?? input.thread,
        policyVersion: input.policyVersion,
        matchedRuleIds: input.assessment.matchedRuleIds,
        scope,
        intent,
        goalId: session.thebeSessionId,
      });
      await goals.startGoal({
        thebeSessionId: session.thebeSessionId,
        goal: executorTask({
          intent,
          rules: input.policy.rules.filter((rule) =>
            input.assessment.matchedRuleIds.includes(rule.id)
          ),
          triggers: input.triggers,
          scope,
        }),
        criteria: [
          "The situation the event describes is resolved, checked with the read tools after any action; or you reported why it cannot be (blocked), or that nothing needed doing (dropped).",
        ],
        executor: "ticket",
      });
      return { ticketId, goalId: session.thebeSessionId };
    },
    now: ctx.now,
    onError: () => {
      // A failed Eval leaves no Decision; the next start weighs it again.
    },
    // One question to the model with no tools. The session exists only for this answer.
    assess: async (prompt, model) => {
      const session = await sessions.createSession({
        title: "eval assessment",
        builtinTools: [],
        labels: { purpose: "eval-assessment" },
        model,
      });
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("assessment timed out")),
            60_000
          );
          timer.unref?.();
        });
        try {
          const reply = await Promise.race([
            prompts.prompt(prompt, {
              thebeSessionId: session.thebeSessionId,
              nonInteractive: true,
            }),
            timeout,
          ]);
          return reply.text;
        } finally {
          if (timer) clearTimeout(timer);
        }
      } finally {
        await sessions.deleteSession(session.thebeSessionId).catch(() => {});
      }
    },
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
    onTriggers: (triggers) => evalService.enqueue(triggers),
    onError: () => {
      // A Source that cannot be read this time (for example Docker is down) is tried again next tick.
    },
  });
  // Triggers recorded before a restart that no Decision covers are weighed now, within an age bound.
  if (options.sources?.containerHealth) {
    void triggerStore.list().then((rows) => evalService.recover(rows));
  }
  sourceRunner.start();
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
    async getPolicy() {
      return withModes(await policyStore.get());
    },
    async setPolicy(input) {
      return withModes(await policyStore.set(input));
    },
    async listDecisions(query) {
      return decisionStore.list(query);
    },
    async getDecision(id) {
      return decisionStore.get(id);
    },
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
      evalService.stop();
      ctx.pipelineAdvancer?.stop();
      await schedules.stop();
      await options.runtime.quiesce();
    },
    async unquiesce() {
      await options.runtime.unquiesce();
      schedules.start();
      evalService.start();
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

/**
 * What a Core says about its policy always includes the modes it has, so a client offers `auto` only where it
 * exists: an older Core does not send this.
 */
function withModes(policy: Policy): Policy & { modes: string[] } {
  return { ...policy, modes: ["off", "observe", "auto"] };
}
