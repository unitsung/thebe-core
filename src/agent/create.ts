import { createControlApi } from "./control/service.ts";
import { createPromptApi } from "./conversations/service.ts";
import { join } from "node:path";
import { createActionApi } from "./action/service.ts";
import { key } from "./tickets/ids.ts";
import { createTicketStore } from "./tickets/store.ts";
import { createTicketControlApi } from "./tickets/control.ts";
import type { Ticket } from "./tickets/types.ts";
import { createContainerHealthSource } from "./sources/container-health.ts";
import {
  createDownloadCompletedSource,
  createUnconfiguredDownloadCompletedSource,
} from "./sources/download-completed.ts";
import { createSourceRunner } from "./sources/runner.ts";
import { createTriggerStore } from "./sources/store.ts";
import type { Trigger } from "./sources/types.ts";
import { createDecisionStore } from "./eval/decision-store.ts";
import { createPolicyStore } from "./eval/policy-store.ts";
import type { Policy } from "./eval/types.ts";
import { createEvalService, DEFAULT_BACKLOG_AGE_MS } from "./eval/service.ts";
import { executorTask } from "./eval/executor-task.ts";
import { ticketIdFor } from "./tickets/ids.ts";
import { inferScope, revalidateMandate } from "./tickets/mandate.ts";
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
import { canRunPipelineJobs } from "./tools/pipeline-tools.ts";
import { createMainSessionApi } from "./main-session/service.ts";

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
  const ticketStore = createTicketStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "tickets")
      : undefined,
  });
  const enabledSources = [
    ...(options.sources?.containerHealth ? ["container-health"] : []),
    ...(options.sources?.downloadCompleted ? ["download-completed"] : []),
  ];
  const policyStore = createPolicyStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "eval")
      : undefined,
    now: ctx.now,
  });
  const servicesForResource = (kind: string): string[] => {
    const services = (options.serviceAPIProviders ?? [])
      .filter((service) => service.resourceKinds?.includes(kind))
      .map((service) => service.id);
    if (kind === "download" && options.pipeline) {
      services.push("download");
      if (options.pipeline.files) services.push("files");
      if (options.pipeline.libraries?.length) services.push("library");
      if (canRunPipelineJobs(options.pipeline)) services.push("pipeline");
    }
    return [...new Set(services)];
  };
  const { watchdog: goalWatchdog, ...goals } = createGoalApi(
    ctx,
    subagents,
    artifactStore,
    reportInbox,
    {
      watchdog: options.watchdog,
      getTicketIdForGoal: async (goalId) =>
        (await ticketStore.getByGoal(goalId))?.id,
      revalidateMandate: async (goalId) => {
        const ticket = await ticketStore.getByGoal(goalId);
        if (!ticket) {
          return {
            allowed: false,
            reason: "the Eval-created Ticket is missing",
          };
        }
        if (ticket.mandate.decidedBy !== "eval") {
          return {
            allowed: false,
            reason: "the Goal's Ticket is not an Eval-created Ticket",
          };
        }
        return revalidateMandate({
          mandate: ticket.mandate,
          subscriptions: ticket.subscriptions,
          policy: await policyStore.get(),
          servicesForResource,
          enabledSources,
        });
      },
      onNeedsPerson: options.onGoalNeedsPerson,
    }
  );
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
  goalWatchdog.start();
  ctx.pipelineAdvancer?.start();
  const activityStore = createActivityStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "activity")
      : undefined,
    now: ctx.now,
    onPendingApproval: options.onPendingApproval,
  });
  const triggerStore = createTriggerStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "triggers")
      : undefined,
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
    sources: enabledSources.join(","),
    maxPerHour: options.evalMaxPerHour,
    threadTickets: async (thread) => {
      // The work taken on for this thread that the Eval could still be looking at: nothing older than the
      // oldest event it weighs.
      const since = ctx.now().getTime() - DEFAULT_BACKLOG_AGE_MS;
      const rows = (await ticketStore.list()).filter(
        (ticket) =>
          ticket.subscriptions.some(
            (s) =>
              s === thread ||
              (s.startsWith("resource:") ? s : `resource:${s}`) ===
                (thread.startsWith("resource:") ? thread : `resource:${thread}`)
          ) && Date.parse(ticket.createdAt) >= since
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
      const scope = inferScope(input.triggers, servicesForResource);
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
    onUnavailable: options.onEvalUnavailable,
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

  async function isTicketLive(ticket: Ticket): Promise<boolean> {
    if (!ticket.links.legacyGoalId) return false;
    const goal =
      goals.getGoal(ticket.links.legacyGoalId) ??
      (await goals.listGoals()).find(
        (g) => g.thebeSessionId === ticket.links.legacyGoalId
      );
    if (!goal) return false;
    return (
      goal.status === "running" ||
      goal.status === "pausing" ||
      goal.status === "paused"
    );
  }

  async function dispatchTriggers(triggers: readonly Trigger[]): Promise<void> {
    const unattached: Trigger[] = [];
    for (const trigger of triggers) {
      const attachedTo = await ticketStore.attachTrigger({
        trigger,
        isLive: isTicketLive,
        attachedAt: ctx.now().toISOString(),
      });
      if (attachedTo.length === 0) {
        unattached.push(trigger);
      }
    }
    if (unattached.length > 0) {
      evalService.enqueue(unattached);
    }
  }

  const sourceRunner = createSourceRunner({
    sources: [
      ...(options.sources?.containerHealth
        ? [
            createContainerHealthSource({
              provider: options.provider,
              now: ctx.now,
            }),
          ]
        : []),
      ...(options.sources?.downloadCompleted
        ? [
            options.pipeline?.downloads
              ? createDownloadCompletedSource({
                  downloads: options.pipeline.downloads,
                  now: ctx.now,
                })
              : createUnconfiguredDownloadCompletedSource(),
          ]
        : []),
    ],
    store: triggerStore,
    intervalMs: options.sources?.intervalMs,
    now: ctx.now,
    onTriggers: (triggers) => void dispatchTriggers(triggers),
    onError: () => {
      // A Source that cannot be read this time (for example Docker is down) is tried again next tick.
    },
  });
  // Triggers recorded before a restart that no Decision covers are weighed now, within an age bound.
  if (enabledSources.length > 0) {
    void triggerStore.list().then(async (rows) => {
      const unattached: Trigger[] = [];
      for (const trigger of rows) {
        const attachedTo = await ticketStore.attachTrigger({
          trigger,
          isLive: isTicketLive,
          attachedAt: ctx.now().toISOString(),
        });
        if (attachedTo.length === 0) {
          unattached.push(trigger);
        }
      }
      evalService.recover(unattached);
    });
  }
  sourceRunner.start();
  const ticketControl = createTicketControlApi({
    store: ticketStore,
    goals,
    sessions,
    now: ctx.now,
  });
  const mainSession = createMainSessionApi({
    ctx,
    tickets: ticketControl,
    sessions,
    prompts,
    model: options.mainSessionModel,
  });
  return {
    runtime: options.runtime,
    workspacePath: ctx.workspacePath,
    mainSessionId: mainSession.mainSessionId,
    getMainSession: mainSession.getMainSession,
    askMainSession: mainSession.askMainSession,
    ...prompts,
    ...sessions,
    ...goals,
    ...extensions,
    ...subagents,
    ...createControlApi(ctx, artifactStore, {
      executeAction: actions.executeApprovedAction,
      tickets: ticketControl,
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
    sourceHealth: sourceRunner.health,
    async listTickets() {
      return ticketStore.list();
    },
    async getTicket(id) {
      return ticketStore.get(id);
    },
    async getTicketForGoal(goalId) {
      return ticketStore.getByGoal(goalId);
    },
    async delegateTicket(input) {
      return ticketControl.delegateHttp(input);
    },
    async replyTicket(input) {
      return ticketControl.reply(input);
    },
    async recordGoalTicket(run, goalOptions) {
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
        subscriptions: goalOptions?.threads,
      });
    },
    async attachTrigger(trigger) {
      return ticketStore.attachTrigger({
        trigger,
        isLive: isTicketLive,
        attachedAt: ctx.now().toISOString(),
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
      goalWatchdog.stop();
      sourceRunner.stop();
      evalService.stop();
      ctx.pipelineAdvancer?.stop();
      await schedules.stop();
      await options.runtime.quiesce();
    },
    async unquiesce() {
      await options.runtime.unquiesce();
      goalWatchdog.start();
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
