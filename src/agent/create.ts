import { createControlApi } from "./control/service.ts";
import { createPromptApi } from "./conversations/service.ts";
import { join } from "node:path";
import { createActionApi } from "./action/service.ts";
import { createTicketStore } from "./tickets/store.ts";
import { createTicketControlApi } from "./tickets/control.ts";
import { recoverInterruptedTicketGoals } from "./tickets/recovery.ts";
import type { Ticket } from "./tickets/types.ts";
import { createTicketChannelNotifier } from "./channels/delivery.ts";
import { createContainerHealthSource } from "./sources/container-health.ts";
import {
  createDownloadCompletedSource,
  createUnconfiguredDownloadCompletedSource,
} from "./sources/download-completed.ts";
import { createSourceRunner } from "./sources/runner.ts";
import { createTriggerStore } from "./sources/store.ts";
import type { Trigger } from "./sources/types.ts";
import { createDecisionStore } from "./eval/decision-store.ts";
import { createEvalDispositionStore } from "./eval/disposition-store.ts";
import { createPolicyStore } from "./eval/policy-store.ts";
import type { Decision, Policy } from "./eval/types.ts";
import { createEvalService, DEFAULT_BACKLOG_AGE_MS } from "./eval/service.ts";
import { createCandidateApi } from "./eval/candidates.ts";
import { createEvalRoutingApi } from "./eval/routing.ts";
import { executorTask } from "./eval/executor-task.ts";
import { prepareForEval } from "./eval/preparation.ts";
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
import { createResidentMainSession } from "./main-session/resident.ts";
import { createBackgroundBudgetService } from "./usage/budget.ts";

/** Authoritative composition root for the agent layer. */
export function createThebeAgent(options: CreateThebeAgentOptions): ThebeAgent {
  const ctx = createAgentContext(options);
  const backgroundBudget = createBackgroundBudgetService({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "usage")
      : undefined,
    now: ctx.now,
    initialDailyTokens: options.dailyBackgroundTokenBudget,
    thresholds: options.dailyBackgroundTokenBudgetThresholds,
    onPaused: options.onBackgroundBudgetPaused,
    onThreshold: options.onBackgroundBudgetThreshold,
    onNotice: options.onBackgroundBudgetNotice,
  });
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
  const subagents = createSubagentApi(
    ctx,
    artifactStore,
    reportInbox,
    backgroundBudget
  );
  const ticketStore = createTicketStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "tickets")
      : undefined,
  });
  const channelNotifier = createTicketChannelNotifier({
    tickets: ticketStore,
    adapters: options.channelAdapters ?? [],
    outboxDir: options.agentStoreDir
      ? join(options.agentStoreDir, "channels")
      : undefined,
    now: ctx.now,
  });
  channelNotifier.start();
  const enabledSources = [
    ...(options.sources?.containerHealth ? ["container-health"] : []),
    ...(options.sources?.downloadCompleted ? ["download-completed"] : []),
    ...(options.sourceAdapters ?? []).map((source) => source.id),
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
  async function revalidateTicketGoal(
    goalId: string
  ): Promise<ReturnType<typeof revalidateMandate>> {
    const ticket = await ticketStore.getByGoal(goalId);
    if (!ticket) {
      return {
        allowed: false,
        reason: "the Ticket is missing",
      };
    }
    return revalidateMandate({
      mandate: ticket.mandate,
      subscriptions: ticket.subscriptions,
      policy: await policyStore.get(),
      servicesForResource,
      enabledSources,
    });
  }
  const { watchdog: goalWatchdog, ...goals } = createGoalApi(
    ctx,
    subagents,
    artifactStore,
    reportInbox,
    {
      watchdog: options.watchdog,
      getTicketIdForGoal: async (goalId) =>
        (await ticketStore.getByGoal(goalId))?.id,
      revalidateMandate: revalidateTicketGoal,
      ticketInputs: async (goalId) =>
        (await ticketStore.getByGoal(goalId))?.inputs ?? [],
      onNeedsPerson: async (notice) => {
        // The outbox entry is written before the Goal reports its terminal state, so a shutdown
        // cannot lose it; sending stays in the background.
        try {
          await channelNotifier.enqueueNeedsPerson(notice);
          void channelNotifier.flush().catch(() => {});
        } finally {
          await options.onGoalNeedsPerson?.(notice);
        }
      },
      onCompleted: async (notice) => {
        await channelNotifier.enqueueCompleted(notice);
        void channelNotifier.flush().catch(() => {});
      },
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
    backgroundBudget,
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
  const evalDispositions = createEvalDispositionStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "eval", "dispositions")
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
    sources: [
      ...enabledSources,
      ...(options.sourceAdapters ?? []).flatMap((source) =>
        (source.assessedKinds ?? []).map((kind) => `${source.id}:${kind}`)
      ),
    ].join(","),
    assessedKinds: (options.sourceAdapters ?? []).flatMap(
      (source) => source.assessedKinds ?? []
    ),
    backgroundBudget,
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
    prepare: ({ triggers }) =>
      prepareForEval(triggers, {
        diagnosis,
        now: ctx.now,
        downloads: options.pipeline?.downloads,
        mediaLibraries: [
          ...(options.emby
            ? [{ service: "emby" as const, provider: options.emby }]
            : []),
          ...(options.jellyfin
            ? [{ service: "jellyfin" as const, provider: options.jellyfin }]
            : []),
        ],
      }),
    accept: async (input) => {
      const ticketId = ticketIdFor(input.evalId);
      const intent = input.assessment.intent ?? `Handle ${input.thread}`;
      const scope = inferScope(input.triggers, servicesForResource);
      // Made again after a crash: the same Eval is the same Ticket, and its Goal already started.
      const existing = await ticketStore.get(ticketId);
      if (existing?.links.legacyGoalId) {
        const goalId = existing.links.legacyGoalId;
        const goal =
          goals.getGoal(goalId) ??
          (await goals.listGoals()).find(
            (run) => run.thebeSessionId === goalId
          );
        // A crash between recording the Ticket and starting its executor leaves the accepted work
        // without a Goal; start it now instead of reporting success forever without running it.
        if (!goal) {
          await goals.startGoal({
            thebeSessionId: goalId,
            goal: executorTask({
              intent,
              rules: input.policy.rules.filter((rule) =>
                input.assessment.matchedRuleIds.includes(rule.id)
              ),
              triggers: input.triggers,
              scope,
              ...(input.preparation ? { preparation: input.preparation } : {}),
            }),
            criteria: [
              "The situation the event describes is resolved, checked with the read tools after any action; or you reported why it cannot be (blocked), or that nothing needed doing (dropped).",
            ],
            executor: "ticket",
          });
        }
        return { ticketId, goalId };
      }
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
        triggers: input.triggers,
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
          ...(input.preparation ? { preparation: input.preparation } : {}),
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
        try {
          const opened = await ctx.openSession(session.thebeSessionId);
          const context = await opened.session.getContextUsage();
          await backgroundBudget.recordSession({
            id: `eval:${context.sessionStats?.sessionId ?? session.runtimeSessionId}`,
            context,
          });
        } catch {
          // A runtime that cannot report usage must not turn a usable assessment into an outage.
        }
        await sessions.deleteSession(session.thebeSessionId).catch(() => {});
      }
    },
  });
  const evalRouting = createEvalRoutingApi({
    triggers: triggerStore,
    tickets: ticketStore,
    dispositions: evalDispositions,
    eval: evalService,
    checkWritable: ctx.checkNotQuiesced,
    now: ctx.now,
  });
  let residentMainSession:
    | ReturnType<typeof createResidentMainSession>
    | undefined;

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
    const explicit: Trigger[] = [];
    for (const trigger of triggers) {
      if (trigger.admission === "ignore") continue;
      // An explicitly addressed request belongs to the resident Main Session. It must not be
      // swallowed as a follow-up to an unrelated open Ticket or weighed as inferred work.
      if (trigger.admission === "explicit") {
        explicit.push(trigger);
        continue;
      }
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
    const residentTriggers = [...unattached, ...explicit].sort((a, b) =>
      a.at.localeCompare(b.at)
    );
    if (residentTriggers.length > 0) {
      await residentMainSession?.enqueue(residentTriggers).catch(() => {});
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
      ...(options.sourceAdapters ?? []),
    ],
    store: triggerStore,
    intervalMs: options.sources?.intervalMs,
    now: ctx.now,
    onTriggers: dispatchTriggers,
    onError: () => {
      // A Source that cannot be read this time (for example Docker is down) is tried again next tick.
    },
  });
  async function recoverSourceTriggers(): Promise<void> {
    if (enabledSources.length === 0) return;
    const rows = await triggerStore.list();
    const unattached: Trigger[] = [];
    const explicit: Trigger[] = [];
    for (const trigger of rows) {
      if (trigger.admission === "ignore") continue;
      if (trigger.admission === "explicit") {
        explicit.push(trigger);
        continue;
      }
      const attachedTo = await ticketStore.attachTrigger({
        trigger,
        isLive: isTicketLive,
        attachedAt: ctx.now().toISOString(),
      });
      if (attachedTo.length === 0) {
        unattached.push(trigger);
      }
    }
    await evalService.recover(unattached);
    const residentTriggers = [...unattached, ...explicit].sort((a, b) =>
      a.at.localeCompare(b.at)
    );
    await residentMainSession?.enqueue(residentTriggers);
  }
  void evalDispositions
    .listTriggerRequeues()
    .then(async (requeues) => {
      for (const requeue of requeues) {
        const trigger = await triggerStore.get(requeue.triggerId);
        if (trigger) evalService.requeue(trigger, requeue.id);
      }
    })
    .catch(() => {
      // A later explicit requeue retries; restart recovery must not block Core.
    });
  // The recovery promise is created after this API, but every caller reaches its reads only after
  // composition finishes, so the placeholder is never observed. Gating inside the API covers HTTP,
  // MCP tools, and the main Session with one rule instead of trusting each call site to wait.
  let ticketReady: Promise<unknown> = Promise.resolve();
  const ticketControl = createTicketControlApi({
    store: ticketStore,
    triggers: triggerStore,
    goals,
    sessions,
    now: ctx.now,
    ready: () => ticketReady,
  });
  // A Ticket whose executor was mid-checkpoint when the previous process ended continues without
  // waiting for the person; a paused, stopped, or attention-waiting Ticket is deliberately left alone.
  const ticketRecovery = recoverInterruptedTicketGoals({
    tickets: ticketStore,
    lookup: (goalId) => ctx.lookup(goalId),
    restore: (goal, events) => goals.restoreGoal(goal, events),
    revalidate: revalidateTicketGoal,
    resume: (goalId) => goals.resumeGoal(goalId),
    onError: () => {
      // The Ticket stays paused and its view carries the error; startup must not fail.
    },
  }).catch(() => []);
  ticketReady = ticketRecovery;
  const candidates = createCandidateApi({
    decisions: decisionStore,
    dispositions: evalDispositions,
    tickets: ticketStore,
    ticketView: ticketControl.get,
    triggers: triggerStore,
    policy: policyStore,
    goals: {
      startGoal: goals.startGoal,
      reopenGoal: goals.reopenGoalForInput,
    },
    sessions,
    servicesForResource,
    now: ctx.now,
  });
  void ticketControl.backfillGoals().catch(() => {
    // The next Ticket read retries; a migration failure must not prevent Core from starting.
  });
  const mainSession = createMainSessionApi({
    ctx,
    candidates,
    routing: evalRouting,
    tickets: ticketControl,
    artifacts: artifactStore,
    backgroundBudget,
    usageDir: options.agentStoreDir
      ? join(options.agentStoreDir, "main-session")
      : undefined,
    maxProactiveWords: options.maxProactiveWords,
    onProactiveMessage: options.onProactiveMessage,
    sessions,
    prompts,
    model: options.mainSessionModel,
  });
  residentMainSession = createResidentMainSession({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "main-session")
      : undefined,
    triggers: triggerStore,
    tickets: ticketControl,
    getMainSession: mainSession.getMainSession,
    waitForEval: () => evalService.idle(),
    prompt: (input) => mainSession.askResidentMainSession(input),
    budget: backgroundBudget,
    abort: () => ctx.requestStop(),
    maxProactiveWords: options.maxProactiveWords,
    onProactiveMessage: options.onProactiveMessage,
    onError: () => {
      // A failed resident turn stays pending and is retried without blocking new Source reads.
    },
  });
  mainSession.setResidentWake(() => {
    residentMainSession?.start();
    residentMainSession?.kick();
  });
  mainSession.setResidentLifecycle({
    pauseForPerson: async () => {
      await residentMainSession?.pauseForPerson();
    },
    resumeAfterPerson: () => residentMainSession?.resumeAfterPerson(),
  });
  let residentRecoveryPromise: Promise<unknown> | undefined;
  if (enabledSources.length > 0) {
    residentMainSession.start();
    residentRecoveryPromise = recoverSourceTriggers()
      .then(() => residentMainSession?.enqueueRecovery())
      .catch(() => residentMainSession?.enqueueRecovery())
      .catch(() => {
        // A later Source poll uses the same durable Trigger store.
      });
  } else {
    residentRecoveryPromise = residentMainSession
      .enqueueRecovery()
      .then(() => mainSession.getMainSession())
      .then(async (existing) => {
        if (!existing) return;
        residentMainSession?.start();
        residentMainSession?.kick();
      })
      .catch(() => {
        // A later main-Session message starts recovery.
      });
  }
  sourceRunner.start();
  async function projectDecisions(rows: Decision[]): Promise<Decision[]> {
    return candidates.project(rows);
  }
  return {
    runtime: options.runtime,
    workspacePath: ctx.workspacePath,
    mainSessionId: mainSession.mainSessionId,
    getMainSession: mainSession.getMainSession,
    askMainSession: mainSession.askMainSession,
    onProactiveMessage: options.onProactiveMessage,
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
    getBackgroundBudgetSummary: () => backgroundBudget.summary(),
    recordBackgroundUsage: (input) => backgroundBudget.record(input),
    setDailyBackgroundTokenBudget: (dailyTokens, thresholds) => {
      if (dailyTokens !== undefined) {
        return backgroundBudget.setDailyTokens(dailyTokens, thresholds);
      }
      if (thresholds !== undefined) {
        return backgroundBudget.setThresholds(thresholds);
      }
      return backgroundBudget.summary();
    },
    resolveBackgroundBudgetSuggestion: (action) =>
      backgroundBudget.resolveSuggestion(action),
    async listDecisions(query) {
      return projectDecisions(await decisionStore.list(query));
    },
    async getDecision(id) {
      const decision = await decisionStore.get(id);
      if (!decision) return undefined;
      return (await projectDecisions([decision]))[0];
    },
    async acceptDecision(decisionId) {
      return candidates.accept(decisionId);
    },
    async attachDecision(input) {
      return candidates.attach(input);
    },
    async dismissDecision(input) {
      return candidates.dismiss(input.decisionId, input.reason);
    },
    async requeueTrigger(triggerId) {
      return evalRouting.requeueTrigger(triggerId, "api");
    },
    async unsubscribeThread(thread) {
      return evalRouting.unsubscribeThread(thread);
    },
    async listTriggers(query) {
      return triggerStore.list(query);
    },
    sourceHealth: sourceRunner.health,
    async listTickets() {
      await ticketRecovery;
      await ticketControl.backfillGoals();
      return ticketStore.list();
    },
    async getTicket(id) {
      await ticketRecovery;
      return ticketStore.get(id);
    },
    async getTicketForGoal(goalId) {
      await ticketRecovery;
      await ticketControl.backfillGoals();
      return ticketStore.getByGoal(goalId);
    },
    async delegateTicket(input) {
      await ticketRecovery;
      return ticketControl.delegateHttp(input);
    },
    async replyTicket(input) {
      await ticketRecovery;
      return ticketControl.reply(input);
    },
    async noteTicket(input) {
      await ticketRecovery;
      return ticketControl.note(input);
    },
    async controlTicket(input) {
      await ticketRecovery;
      return ticketControl.control(input);
    },
    async recordGoalTicket(run, goalOptions) {
      // The person asked for this task: a direct Decision, so Eval does not weigh it.
      return ticketControl.recordGoal(run, {
        requester: "chat",
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
      evalService.stop();
      await sourceRunner.stop();
      await evalService.idle();
      await residentRecoveryPromise?.catch(() => {});
      await residentMainSession?.stop();
      await channelNotifier.stop();
      ctx.pipelineAdvancer?.stop();
      await schedules.stop();
      await options.runtime.quiesce();
    },
    async unquiesce() {
      await options.runtime.unquiesce();
      goalWatchdog.start();
      schedules.start();
      evalService.start();
      residentMainSession?.start();
      channelNotifier.start();
      sourceRunner.start();
      ctx.pipelineAdvancer?.start();
    },
    diagnose: diagnosis.diagnose,
    getDiagnosis: diagnosis.getDiagnosis,
    explainDiagnosis: diagnosis.explainDiagnosis,
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
