import type { GoalEvent } from "../goals/runner.ts";
import {
  executeGoal,
  type GoalCheckpointInput,
  type GoalSubagentApi,
  type ManagedGoal,
} from "./execution.ts";
import type {
  GoalRun,
  GoalRunStatus,
  GoalWatchdogReason,
  GoalWatchdogState,
  SubagentRun,
  SubagentUpdate,
} from "../types.ts";
import type { AgentContext } from "../internal/context.ts";
import { createGoalReportInbox, type GoalReportInbox } from "./report.ts";
import type { StoredGoalEvent } from "../store.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import { httpError } from "../types.ts";
import { stripToolLogs, shortenToWords } from "../main-session/proactive.ts";
import { hashParameters } from "../security/audit/audit-log.ts";
import type { MandateRevalidation } from "../tickets/mandate.ts";
import {
  buildGoalStatusCheckPrompt,
  createGoalWatchdog,
  type GoalWatchdogTarget,
  type WatchdogDecision,
} from "../watchdog/service.ts";

const MAX_GOAL_EVENTS = 50;
/** Longest answer or review note accepted; it goes into every later checkpoint prompt. */
const MAX_ANSWER_CHARS = 4000;

export type GoalNeedsPersonNotice = {
  id: string;
  goalId: string;
  ticketId?: string;
  reason: "answer" | "review" | "blocked" | "stalled";
  message: string;
};

export type GoalCompletedNotice = {
  id: string;
  goalId: string;
  ticketId?: string;
  message: string;
};

export type GoalApiOptions = {
  watchdog?: {
    intervalMs?: number;
    goalFirstMs?: number;
    goalSecondMs?: number;
    workerFirstMs?: number;
    workerSecondMs?: number;
  };
  getTicketIdForGoal?: (goalId: string) => Promise<string | undefined>;
  revalidateMandate?: (goalId: string) => Promise<MandateRevalidation>;
  ticketInputs?: (goalId: string) => Promise<GoalCheckpointInput[]>;
  onNeedsPerson?: (notice: GoalNeedsPersonNotice) => Promise<void> | void;
  onCompleted?: (notice: GoalCompletedNotice) => Promise<void> | void;
};

export function createGoalApi(
  ctx: AgentContext,
  subagents: GoalSubagentApi,
  artifactStore?: ArtifactStore,
  reportInbox: GoalReportInbox = createGoalReportInbox(ctx.now),
  options: GoalApiOptions = {}
) {
  const runs = new Map<string, ManagedGoal>();
  const persistChains = new Map<string, Promise<void>>();
  const retryFlights = new Map<string, Promise<GoalRun>>();

  const snapshot = (run: ManagedGoal): GoalRun => ({
    thebeSessionId: run.thebeSessionId,
    goal: run.goal,
    criteria: run.criteria?.slice(),
    maxIterations: run.maxIterations,
    iteration: run.iteration,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    progressAt: run.progressAt,
    subagentRunIds: run.subagentRunIds.slice(),
    activeSubagent: run.activeSubagent ? { ...run.activeSubagent } : undefined,
    lastReview: run.lastReview
      ? {
          ...run.lastReview,
          remainingTasks: run.lastReview.remainingTasks?.slice(),
        }
      : undefined,
    finishedAt: run.finishedAt,
    summary: run.summary,
    finalReport: run.finalReport,
    artifactId: run.artifactId,
    error: run.error,
    ...(run.blocked ? { blocked: true } : {}),
    ...(run.observe ? { observe: true } : {}),
    ...(run.executor ? { executor: run.executor } : {}),
    ...(run.report ? { report: { ...run.report } } : {}),
    ...(run.attention ? { attention: { ...run.attention } } : {}),
    ...(run.allowAsk ? { allowAsk: true } : {}),
    ...(run.reviewBeforeDone ? { reviewBeforeDone: true } : {}),
    ...(run.guidance?.length ? { guidance: run.guidance.slice() } : {}),
    ...(run.ticketInputSeq ? { ticketInputSeq: run.ticketInputSeq } : {}),
    ...(run.watchdog ? { watchdog: { ...run.watchdog } } : {}),
  });

  const RECOVERY_MESSAGE =
    "Goal recovered as paused after Core restart; resume it to continue.";

  function publish(
    run: ManagedGoal,
    event: GoalEvent,
    progress = false
  ): Promise<void> {
    const at = ctx.now().toISOString();
    if (progress) run.progressAt = at;
    run.updatedAt = at;
    run.events.push({ event, at });
    if (run.events.length > MAX_GOAL_EVENTS) {
      run.events.splice(0, run.events.length - MAX_GOAL_EVENTS);
    }
    const persisted = queueGoalPersistence(
      snapshot(run),
      run.thebeSessionId,
      storedGoalEvents(run.events)
    );
    for (const listener of run.listeners) listener(event);
    return persisted;
  }

  function broadcast(
    run: ManagedGoal,
    event: GoalEvent,
    progress = false
  ): void {
    void publish(run, event, progress);
  }

  async function notifyNeedsPerson(run: ManagedGoal): Promise<void> {
    if (!options.onNeedsPerson) return;
    const notice = personNotice(run);
    if (!notice || run.personNoticeId === notice.id) return;
    try {
      const ticketId = await options.getTicketIdForGoal?.(run.thebeSessionId);
      await options.onNeedsPerson({
        ...notice,
        ...(ticketId ? { ticketId } : {}),
      });
      run.personNoticeId = notice.id;
    } catch {
      // A notification adapter must not change Goal state. The id stays unmarked so a later
      // terminal write can try again.
    }
  }

  async function notifyCompleted(run: ManagedGoal): Promise<void> {
    if (!options.onCompleted) return;
    const notice = completionNotice(run);
    if (!notice || run.completedNoticeId === notice.id) return;
    try {
      const ticketId = await options.getTicketIdForGoal?.(run.thebeSessionId);
      await options.onCompleted({
        ...notice,
        ...(ticketId ? { ticketId } : {}),
      });
      run.completedNoticeId = notice.id;
    } catch {
      // A notification adapter must not change Goal state.
    }
  }

  async function setTerminal(
    run: ManagedGoal,
    status: Exclude<GoalRunStatus, "running" | "pausing">,
    summary?: string,
    error?: string
  ): Promise<GoalRun> {
    const finalSummary =
      status === "paused" && run.watchdog?.state === "waiting_for_person"
        ? (run.watchdog.summary ??
          `Paused by Watchdog: ${watchdogReasonText(run.watchdog.reason)}. It needs you to decide how to continue.`)
        : summary;
    run.status = status;
    // A question or review belongs to the paused state: once the Goal ends another way, it is no
    // longer answerable and must not keep the Ticket in the needs-you section.
    if (status !== "paused") run.attention = undefined;
    run.summary = finalSummary;
    run.error = error;
    run.finishedAt = ctx.now().toISOString();
    run.updatedAt = run.finishedAt;
    run.progressAt = run.finishedAt;
    if (
      status !== "paused" &&
      artifactStore &&
      !run.artifactId &&
      run.finalReport?.trim()
    ) {
      try {
        const artifact = await artifactStore.create({
          kind: "report",
          title: `Goal report: ${run.goal}`,
          content: run.finalReport,
          contentType: "text/plain; charset=utf-8",
          sessionId: run.thebeSessionId,
        });
        run.artifactId = artifact.artifactId;
      } catch {
        // A report Artifact is supplementary; it must not change Goal state.
      }
    }
    broadcast(run, {
      type: "goal_completed",
      // GoalEvent's generic loop has no paused terminal state; the UI has the
      // authoritative GoalRun snapshot and renders paused separately.
      status: status === "paused" ? "cancelled" : status,
      totalIterations: run.iteration,
      summary: finalSummary ?? `Goal ${status}.`,
    });
    // Make the notice durable before the terminal state is written, so a crash between the two
    // cannot leave a finished Goal whose Ticket never hears about it.
    await notifyNeedsPerson(run);
    await notifyCompleted(run);
    const result = snapshot(run);
    await queueGoalPersistence(
      result,
      run.thebeSessionId,
      storedGoalEvents(run.events)
    );
    run.resolveFinished(result);
    return result;
  }

  function onGoalEvent(run: ManagedGoal, event: GoalEvent): void {
    if (event.type === "goal_iteration") {
      run.iteration = event.iteration;
    } else if (event.type === "goal_reviewed") {
      run.lastReviewResult = {
        complete: event.complete,
        score: event.score,
        critique: event.critique,
        remainingTasks: event.remainingTasks?.slice(),
      };
      run.lastReview = {
        score: event.score,
        critique: event.critique,
        remainingTasks: event.remainingTasks?.slice(),
      };
    }
    broadcast(
      run,
      event,
      event.type !== "goal_status" || event.status === "running"
    );
  }

  function resetFinished(run: ManagedGoal): void {
    run.finished = new Promise<GoalRun>((resolve) => {
      run.resolveFinished = resolve;
    });
  }

  async function persistGoal(
    run: GoalRun | undefined,
    thebeSessionId: string,
    events: StoredGoalEvent[] = []
  ): Promise<void> {
    try {
      const meta = await ctx.lookup(thebeSessionId);
      await ctx.persist(
        ctx.touchMeta({
          ...meta,
          goalRun: run,
          goalEvents: run ? events.slice(-MAX_GOAL_EVENTS) : undefined,
        })
      );
    } catch {
      // A persistence failure must not turn a completed Goal into a failure.
    }
  }

  function queueGoalPersistence(
    run: GoalRun | undefined,
    thebeSessionId: string,
    events: StoredGoalEvent[] = []
  ): Promise<void> {
    const previous = persistChains.get(thebeSessionId) ?? Promise.resolve();
    const next = previous.then(
      () => persistGoal(run, thebeSessionId, events),
      () => persistGoal(run, thebeSessionId, events)
    );
    persistChains.set(thebeSessionId, next);
    void next.then(
      () => {
        if (persistChains.get(thebeSessionId) === next) {
          persistChains.delete(thebeSessionId);
        }
      },
      () => {
        if (persistChains.get(thebeSessionId) === next) {
          persistChains.delete(thebeSessionId);
        }
      }
    );
    return next;
  }

  function restoreGoal(
    persisted: GoalRun | undefined,
    persistedEvents: StoredGoalEvent[] = []
  ): void {
    if (!persisted || runs.has(persisted.thebeSessionId)) return;
    const interrupted =
      persisted.status === "running" || persisted.status === "pausing";
    const run = createRun({
      thebeSessionId: persisted.thebeSessionId,
      goal: persisted.goal,
      criteria: persisted.criteria,
      maxIterations: persisted.maxIterations,
      observe: persisted.observe,
      executor: persisted.executor,
      allowAsk: persisted.allowAsk,
      reviewBeforeDone: persisted.reviewBeforeDone,
    });
    // These would otherwise be lost on restart: what the run was allowed to do, why it stopped, and what
    // it is waiting on the person for.
    if (persisted.blocked) run.blocked = true;
    if (persisted.report) run.report = { ...persisted.report };
    if (persisted.attention) run.attention = { ...persisted.attention };
    if (persisted.guidance?.length) run.guidance = persisted.guidance.slice();
    if (persisted.ticketInputSeq) {
      run.ticketInputSeq = persisted.ticketInputSeq;
    }
    run.iteration = persisted.iteration;
    run.status = interrupted ? "paused" : persisted.status;
    run.createdAt = persisted.createdAt;
    run.updatedAt =
      persisted.updatedAt ?? persisted.finishedAt ?? persisted.createdAt;
    run.progressAt =
      persisted.progressAt ?? persisted.updatedAt ?? persisted.createdAt;
    run.subagentRunIds = persisted.subagentRunIds.slice();
    run.activeSubagent = persisted.activeSubagent
      ? { ...persisted.activeSubagent }
      : undefined;
    run.lastReview = persisted.lastReview
      ? {
          ...persisted.lastReview,
          remainingTasks: persisted.lastReview.remainingTasks?.slice(),
        }
      : undefined;
    run.lastReviewResult = persisted.lastReview
      ? {
          complete: run.status === "completed",
          score: persisted.lastReview.score,
          critique: persisted.lastReview.critique,
          remainingTasks: persisted.lastReview.remainingTasks?.slice(),
        }
      : undefined;
    run.finishedAt = persisted.finishedAt;
    run.events = restoreEvents(persistedEvents, persisted.thebeSessionId);
    run.summary = interrupted
      ? `Goal paused after ${run.iteration} checkpoint(s); resume it to continue.`
      : persisted.summary;
    run.finalReport = persisted.finalReport;
    run.artifactId = persisted.artifactId;
    run.error = interrupted
      ? "The previous Goal process ended before its active checkpoint completed."
      : persisted.error;
    if (persisted.watchdog) run.watchdog = { ...persisted.watchdog };
    if (interrupted) {
      const recoveredAt = ctx.now().toISOString();
      run.updatedAt = recoveredAt;
      run.events.push({
        event: {
          type: "goal_status",
          status: "paused",
          message: RECOVERY_MESSAGE,
        },
        at: recoveredAt,
      });
    }
    runs.set(run.thebeSessionId, run);
    if (interrupted && persisted.executor !== "ticket") {
      // A Ticket Goal's interrupted state belongs to startup recovery: persisting the pause here
      // would race that pass and make it skip a run that should resume. Recovery, a person's
      // action, or a later restart records the real transition.
      void queueGoalPersistence(
        snapshot(run),
        run.thebeSessionId,
        storedGoalEvents(run.events)
      );
    }
    if (run.status !== "running" && run.status !== "pausing") {
      run.resolveFinished(snapshot(run));
    }
  }

  function emitChild(
    run: ManagedGoal,
    iteration: number,
    role: "worker" | "reviewer",
    update: SubagentUpdate
  ): void {
    const progress =
      update.run.status !== "cancelled" &&
      (Boolean(update.event && update.event.type !== "interrupted") ||
        update.run.status === "completed" ||
        update.run.status === "failed");
    if (progress && run.watchdog?.state !== "waiting_for_person") {
      run.watchdog = undefined;
    }
    run.activeSubagent = update.run;
    broadcast(
      run,
      {
        type: "goal_subagent_update",
        iteration,
        role,
        run: update.run,
        event: update.event,
      },
      progress
    );
  }

  function runManagedGoal(
    run: ManagedGoal,
    initialIteration = 0
  ): Promise<void> {
    return executeGoal(
      run,
      {
        subagents,
        emitChild,
        onEvent: onGoalEvent,
        setTerminal,
        reportInbox,
        ticketInputs: options.ticketInputs,
        now: ctx.now,
      },
      initialIteration,
      run.lastReviewResult
    );
  }

  function createRun(input: {
    thebeSessionId: string;
    goal: string;
    criteria?: string[];
    maxIterations: number;
    observe?: boolean;
    executor?: "ticket";
    allowAsk?: boolean;
    reviewBeforeDone?: boolean;
  }): ManagedGoal {
    let resolveFinished!: (result: GoalRun) => void;
    const createdAt = ctx.now().toISOString();
    const run: ManagedGoal = {
      thebeSessionId: input.thebeSessionId,
      goal: input.goal,
      criteria: input.criteria?.filter(Boolean),
      maxIterations: input.maxIterations,
      ...(input.observe ? { observe: true } : {}),
      ...(input.executor ? { executor: input.executor } : {}),
      ...(input.allowAsk ? { allowAsk: true } : {}),
      ...(input.reviewBeforeDone ? { reviewBeforeDone: true } : {}),
      iteration: 0,
      status: "running",
      createdAt,
      updatedAt: createdAt,
      progressAt: createdAt,
      subagentRunIds: [],
      guidance: [],
      stopRequested: false,
      pauseRequested: false,
      finished: new Promise<GoalRun>((resolve) => {
        resolveFinished = resolve;
      }),
      resolveFinished,
      listeners: new Set(),
      events: [],
    };
    return run;
  }

  async function auditMandateRevalidation(
    run: ManagedGoal,
    reason: string,
    result: "denied" | "error"
  ): Promise<void> {
    try {
      await ctx.audit?.append({
        method: "ticket.mandate_revalidate",
        parameterHash: hashParameters({
          goalId: run.thebeSessionId,
          reason,
        }),
        summary: `Ticket Mandate revalidation ${result}: ${reason}`,
        responseBytes: 0,
        budgetConsumed: 0,
        redactionFired: false,
        result,
        sessionId: run.thebeSessionId,
        source: "ticket",
      });
    } catch {
      // A write failure must never turn a denied recovery into an allowed one.
    }
  }

  /** Refuses recovery when an Eval-created Ticket no longer follows from the current Policy. */
  async function revalidateBeforeContinue(run: ManagedGoal): Promise<void> {
    if (run.executor !== "ticket" || !options.revalidateMandate) return;
    let result: MandateRevalidation;
    try {
      result = await options.revalidateMandate(run.thebeSessionId);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      await auditMandateRevalidation(run, reason, "error");
      throw httpError(
        409,
        `Could not revalidate this task's Ticket: ${reason}`,
        "ticket_mandate_revalidation_failed"
      );
    }
    if (result.allowed) return;
    await auditMandateRevalidation(run, result.reason, "denied");
    throw httpError(
      409,
      `The current Policy no longer authorizes this task to continue: ${result.reason}.`,
      "ticket_mandate_invalid"
    );
  }

  /** Starts the next checkpoint of a paused Goal; the one way a paused run goes back to running. */
  async function continueGoal(
    run: ManagedGoal,
    mandateChecked = false
  ): Promise<GoalRun> {
    if (!mandateChecked) {
      await revalidateBeforeContinue(run);
      // Revalidation is asynchronous: a concurrent resume or answer may have started the run, or a
      // stop may have ended it, while it was in flight. Starting another checkpoint here would run
      // the same Goal twice.
      if (run.status !== "paused") return snapshot(run);
    }
    if (run.status === "running" || run.status === "pausing") {
      return snapshot(run);
    }
    run.status = "running";
    resetFinished(run);
    run.finishedAt = undefined;
    run.summary = undefined;
    run.finalReport = undefined;
    run.artifactId = undefined;
    run.error = undefined;
    run.progressAt = ctx.now().toISOString();
    run.updatedAt = run.progressAt;
    run.watchdog = undefined;
    run.watchdogRetryRequested = undefined;
    run.personNoticeId = undefined;
    run.completedNoticeId = undefined;
    run.pauseRequested = false;
    run.stopRequested = false;
    await queueGoalPersistence(
      snapshot(run),
      run.thebeSessionId,
      storedGoalEvents(run.events)
    );
    broadcast(run, {
      type: "goal_status",
      status: "running",
      message: "Goal resumed with a fresh isolated worker checkpoint.",
    });
    void runManagedGoal(run, run.iteration);
    return snapshot(run);
  }

  /** Clears terminal product state, then starts a fresh recovery checkpoint. */
  async function startFreshTerminalCheckpoint(
    run: ManagedGoal
  ): Promise<GoalRun> {
    run.blocked = undefined;
    run.attention = undefined;
    run.report = undefined;
    run.lastReviewResult = undefined;
    run.personNoticeId = undefined;
    run.completedNoticeId = undefined;
    if (run.iteration >= run.maxIterations) {
      run.maxIterations = run.iteration + 1;
    }
    return continueGoal(run, true);
  }

  function assertRetryable(run: ManagedGoal): void {
    if (run.status === "failed" || run.status === "max_iterations") return;
    if (run.status === "cancelled") {
      throw httpError(
        409,
        "a person stopped this Ticket; it cannot be retried",
        "ticket_stopped"
      );
    }
    throw httpError(
      409,
      run.status === "completed"
        ? "ticket is already completed"
        : run.status === "paused"
          ? "ticket is paused; resume it instead"
          : "ticket is already active",
      "invalid_transition"
    );
  }

  function watchdogTarget(run: ManagedGoal): GoalWatchdogTarget {
    return {
      goalId: run.thebeSessionId,
      goal: run.goal,
      iteration: run.iteration,
      ...(run.executor ? { executor: run.executor } : {}),
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt ?? run.createdAt,
      progressAt: run.progressAt ?? run.updatedAt ?? run.createdAt,
      ...(run.report ? { report: { ...run.report } } : {}),
      ...(run.attention ? { attention: { ...run.attention } } : {}),
      ...(run.activeSubagent
        ? { activeSubagent: { ...run.activeSubagent } }
        : {}),
      ...(run.watchdog ? { watchdog: { ...run.watchdog } } : {}),
    };
  }

  async function auditWatchdog(
    run: ManagedGoal,
    state: GoalWatchdogState,
    result: "ok" | "error" = "ok"
  ): Promise<void> {
    await ctx.audit?.append({
      method: `watchdog.${state.action}`,
      parameterHash: hashParameters({
        goalId: run.thebeSessionId,
        reason: state.reason,
        since: state.since,
        runId: run.activeSubagent?.runId,
      }),
      summary: `Watchdog ${state.action}: ${watchdogReasonText(state.reason)}`,
      responseBytes: 0,
      budgetConsumed: 0,
      redactionFired: false,
      result,
      sessionId: run.thebeSessionId,
      source: "watchdog",
    });
  }

  async function recordWatchdog(
    run: ManagedGoal,
    state: GoalWatchdogState
  ): Promise<void> {
    run.watchdog = state;
    broadcast(run, {
      type: "goal_watchdog",
      action: state.action,
      reason: state.reason,
      message: state.summary,
    });
    await auditWatchdog(run, state);
  }

  async function statusCheckFromWatchdog(
    decision: Extract<WatchdogDecision, { type: "status_check" }>
  ): Promise<void> {
    const run = runs.get(decision.target.goalId);
    if (
      !run ||
      run.status !== "running" ||
      (run.progressAt ?? run.updatedAt) !== decision.target.progressAt
    ) {
      return;
    }
    const at = ctx.now().toISOString();
    const state: GoalWatchdogState = {
      state: "checking",
      reason: decision.reason,
      action: "status_check",
      since: decision.target.progressAt,
      at,
      summary:
        "Watchdog started one bounded, read-only status check because this task stopped making progress.",
    };
    await recordWatchdog(run, state);
    try {
      const child = await subagents.spawnSubagent({
        profileName:
          run.executor === "ticket" ? "ticket-observer" : "goal-observer",
        taskPrompt: buildGoalStatusCheckPrompt(
          decision.target,
          decision.inactivityMs
        ),
        parentSessionId: run.thebeSessionId,
        background: true,
      });
      void subagents.waitSubagent(child.runId).then(async (result) => {
        const current = runs.get(run.thebeSessionId);
        if (
          !current ||
          current.watchdog?.state !== "checking" ||
          current.watchdog.at !== at
        ) {
          return;
        }
        const detail = (result.result ?? result.responseText ?? "").trim();
        current.watchdog.summary = detail
          ? `Watchdog status check: ${boundedText(detail, 1000)}`
          : `Watchdog status check ended ${result.status}; no further evidence was returned.`;
        current.updatedAt = ctx.now().toISOString();
        await queueGoalPersistence(
          snapshot(current),
          current.thebeSessionId,
          storedGoalEvents(current.events)
        );
      });
    } catch (error) {
      await auditWatchdog(run, state, "error");
      throw error;
    }
  }

  async function retryWorkerFromWatchdog(
    decision: Extract<WatchdogDecision, { type: "retry_worker" }>
  ): Promise<void> {
    const run = runs.get(decision.target.goalId);
    const active = run?.activeSubagent;
    if (
      !run ||
      run.status !== "running" ||
      !active ||
      active.runId !== decision.run.runId
    ) {
      return;
    }
    const at = ctx.now().toISOString();
    const activity =
      active.activity?.at(-1)?.at ?? active.startedAt ?? active.createdAt;
    const state: GoalWatchdogState = {
      state: "retrying",
      reason: decision.reason,
      action: "retry_worker",
      since: activity,
      at,
      summary:
        decision.reason === "reviewer_inactivity"
          ? "Watchdog is retrying the unresponsive reviewer once."
          : "Watchdog is retrying the unresponsive worker once.",
    };
    run.watchdogRetryRequested = {
      runId: active.runId,
      role: decision.reason === "reviewer_inactivity" ? "reviewer" : "worker",
      at,
    };
    await recordWatchdog(run, state);
    try {
      await subagents.cancelSubagent(active.runId, run.thebeSessionId);
    } catch (error) {
      run.watchdogRetryRequested = undefined;
      await auditWatchdog(run, state, "error");
      throw error;
    }
  }

  async function requestPause(
    run: ManagedGoal,
    message: string
  ): Promise<GoalRun> {
    if (run.status !== "running") return snapshot(run);
    run.pauseRequested = true;
    run.status = "pausing";
    broadcast(run, {
      type: "goal_status",
      status: "pausing",
      message,
    });
    const active = run.activeSubagent;
    if (active && (active.status === "queued" || active.status === "running")) {
      await subagents.cancelSubagent(active.runId, run.thebeSessionId);
    }
    return snapshot(run);
  }

  async function pauseFromWatchdog(
    decision: Extract<WatchdogDecision, { type: "pause" }>
  ): Promise<void> {
    const run = runs.get(decision.target.goalId);
    if (!run || run.status !== "running") return;
    const at = ctx.now().toISOString();
    const state: GoalWatchdogState = {
      state: "waiting_for_person",
      reason: decision.reason,
      action: "pause",
      since:
        decision.reason === "goal_no_progress"
          ? decision.target.progressAt
          : (decision.target.activeSubagent?.activity?.at(-1)?.at ??
            decision.target.activeSubagent?.startedAt ??
            decision.target.updatedAt),
      at,
      summary: watchdogPauseMessage(decision.reason),
    };
    await recordWatchdog(run, state);
    await requestPause(run, state.summary!);
  }

  const watchdog = createGoalWatchdog({
    listTargets: () =>
      [...runs.values()]
        .filter((run) => run.status === "running")
        .map(watchdogTarget),
    execute: async (decision) => {
      if (decision.type === "status_check") {
        await statusCheckFromWatchdog(decision);
      } else if (decision.type === "retry_worker") {
        await retryWorkerFromWatchdog(decision);
      } else {
        await pauseFromWatchdog(decision);
      }
    },
    onError: () => {
      // The next deterministic tick only resumes watching; an intervention is never repeated blindly.
    },
    ...options.watchdog,
    now: ctx.now,
  });

  return {
    async startGoal(input: {
      thebeSessionId: string;
      goal: string;
      criteria?: string[];
      maxIterations?: number;
      observe?: boolean;
      executor?: "ticket";
      allowAsk?: boolean;
      reviewBeforeDone?: boolean;
    }): Promise<GoalRun> {
      ctx.checkNotQuiesced();
      const goal = input.goal.trim();
      if (!goal) throw new Error("goal cannot be empty");
      const existing = runs.get(input.thebeSessionId);
      if (
        existing &&
        (existing.status === "running" || existing.status === "pausing")
      ) {
        throw new Error("a goal is already running for this session");
      }
      if (existing?.status === "paused") {
        throw new Error("goal is paused; use /goal resume");
      }
      await ctx.lookup(input.thebeSessionId);
      const run = createRun({
        thebeSessionId: input.thebeSessionId,
        goal,
        criteria: input.criteria,
        maxIterations: clampIterations(input.maxIterations),
        observe: input.observe,
        executor: input.executor,
        allowAsk: input.allowAsk,
        reviewBeforeDone: input.reviewBeforeDone,
      });
      runs.set(run.thebeSessionId, run);
      await queueGoalPersistence(
        snapshot(run),
        run.thebeSessionId,
        storedGoalEvents(run.events)
      );
      void runManagedGoal(run);
      return snapshot(run);
    },

    getGoal(thebeSessionId: string): GoalRun | undefined {
      const run = runs.get(thebeSessionId);
      return run ? snapshot(run) : undefined;
    },

    async listGoals(): Promise<GoalRun[]> {
      const metas = await ctx.listMetas();
      const seen = new Set<string>();
      const out: GoalRun[] = [];
      for (const [id, run] of runs) {
        out.push(snapshot(run));
        seen.add(id);
      }
      for (const meta of metas) {
        if (!meta.goalRun || seen.has(meta.thebeSessionId)) continue;
        restoreGoal(meta.goalRun, meta.goalEvents);
        const live = runs.get(meta.thebeSessionId);
        if (live) {
          out.push(snapshot(live));
          seen.add(meta.thebeSessionId);
        }
      }
      return out.sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
      );
    },

    goalEvents(
      thebeSessionId: string
    ): Array<{ event: GoalEvent; at: string }> {
      const run = runs.get(thebeSessionId);
      return run
        ? run.events.map((row) => ({ event: row.event, at: row.at }))
        : [];
    },

    restoreGoal,

    subscribeGoal(
      thebeSessionId: string,
      listener: (event: GoalEvent) => void
    ): () => void {
      const run = runs.get(thebeSessionId);
      if (!run) return () => {};
      run.listeners.add(listener);
      return () => run.listeners.delete(listener);
    },

    async waitGoal(thebeSessionId: string): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      return run.status === "running" || run.status === "pausing"
        ? run.finished
        : snapshot(run);
    },

    async pauseGoal(thebeSessionId: string): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      return requestPause(
        run,
        "Stopping the active checkpoint before pausing."
      );
    },

    async resumeGoal(thebeSessionId: string): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      if (run.status !== "paused") return snapshot(run);
      ctx.checkNotQuiesced();
      if (run.attention) {
        throw httpError(
          409,
          run.attention.kind === "review"
            ? "this task is waiting for your review; accept it or say what to change with POST /v1/goals/{id}/answer"
            : "this task is waiting for your answer; give it with POST /v1/goals/{id}/answer",
          "attention_open"
        );
      }
      return continueGoal(run);
    },

    /**
     * Starts a fresh checkpoint for a terminal Ticket Goal after a person explicitly attaches a relevant
     * event. The Ticket and its Mandate stay the same; a person's stop is never undone.
     */
    async reopenGoalForInput(thebeSessionId: string): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      if (
        run.status === "running" ||
        run.status === "pausing" ||
        run.status === "paused"
      ) {
        return snapshot(run);
      }
      if (run.status === "cancelled") {
        throw httpError(
          409,
          "a person stopped this Ticket; attach the event to another Ticket or accept it as new work",
          "ticket_stopped"
        );
      }
      ctx.checkNotQuiesced();
      await revalidateBeforeContinue(run);
      return startFreshTerminalCheckpoint(run);
    },

    /**
     * Starts a fresh checkpoint after machinery failure, a blocker, or the checkpoint limit. The Ticket
     * and its Mandate stay the same; completed work and a person's stop are never undone. Concurrent retry
     * requests share one recovery flight, so a retry cannot start two workers.
     */
    async retryGoal(thebeSessionId: string): Promise<GoalRun> {
      const pending = retryFlights.get(thebeSessionId);
      if (pending) return pending;
      const flight = (async () => {
        const run = runs.get(thebeSessionId);
        if (!run) throw new Error("no goal found for this session");
        assertRetryable(run);
        ctx.checkNotQuiesced();
        await revalidateBeforeContinue(run);
        assertRetryable(run);
        return startFreshTerminalCheckpoint(run);
      })();
      retryFlights.set(thebeSessionId, flight);
      try {
        return await flight;
      } finally {
        if (retryFlights.get(thebeSessionId) === flight) {
          retryFlights.delete(thebeSessionId);
        }
      }
    },

    /**
     * Answers the one open question, or accepts / sends back a finished result. A stale `attentionId`
     * (already answered, or a newer question) is a conflict, never a second answer.
     */
    async answerGoal(
      thebeSessionId: string,
      input: {
        attentionId: string;
        answer?: string;
        decision?: "accept" | "reject";
      }
    ): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      ctx.checkNotQuiesced();
      const attention = run.attention;
      if (run.status !== "paused" || !attention) {
        throw httpError(
          409,
          "this task is not waiting for an answer",
          "attention_none"
        );
      }
      if (input.attentionId !== attention.id) {
        throw httpError(
          409,
          "that request is no longer open; reload the task to see the current one",
          "attention_stale"
        );
      }
      const text = typeof input.answer === "string" ? input.answer.trim() : "";
      if (text.length > MAX_ANSWER_CHARS) {
        throw httpError(
          400,
          `the answer is longer than ${MAX_ANSWER_CHARS} characters`,
          "invalid_body"
        );
      }
      if (run.answerPending) {
        throw httpError(
          409,
          "another answer is already being applied; reload the task",
          "attention_stale"
        );
      }
      // Revalidation is asynchronous; a concurrent stop must not leave us starting a fresh
      // checkpoint from an answer that no longer applies.
      const stillAnswerable = async (): Promise<void> => {
        await revalidateBeforeContinue(run);
        if (run.status !== "paused" || run.attention?.id !== attention.id) {
          throw httpError(
            409,
            "this task changed while the answer was being checked; reload it",
            "attention_stale"
          );
        }
      };
      run.answerPending = true;
      try {
        if (attention.kind === "review") {
          if (input.decision !== "accept" && input.decision !== "reject") {
            throw httpError(
              400,
              "decision must be accept or reject",
              "invalid_body"
            );
          }
          if (input.decision === "accept") {
            run.attention = undefined;
            return await setTerminal(
              run,
              "completed",
              "Goal accepted by you after review."
            );
          }
          if (!text) {
            throw httpError(
              400,
              "say what to change when sending a result back",
              "invalid_body"
            );
          }
          await stillAnswerable();
          (run.guidance ??= []).push(`Review feedback: ${text}`);
        } else {
          if (!text) {
            throw httpError(400, "answer cannot be empty", "invalid_body");
          }
          await stillAnswerable();
          (run.guidance ??= []).push(
            `Your question was "${attention.question}". The person answered: ${text}`
          );
        }
        run.attention = undefined;
        // An answer that lands on the last checkpoint needs one more to be used at all.
        if (run.iteration >= run.maxIterations)
          run.maxIterations = run.iteration + 1;
        return await continueGoal(run, true);
      } finally {
        run.answerPending = false;
      }
    },

    async addGoalGuidance(
      thebeSessionId: string,
      note: string
    ): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      ctx.checkNotQuiesced();
      const text = note.trim();
      if (!text) {
        throw httpError(400, "guidance cannot be empty", "invalid_body");
      }
      if (text.length > MAX_ANSWER_CHARS) {
        throw httpError(
          400,
          `guidance is longer than ${MAX_ANSWER_CHARS} characters`,
          "invalid_body"
        );
      }
      if (
        run.status !== "running" &&
        run.status !== "pausing" &&
        run.status !== "paused"
      ) {
        throw httpError(
          409,
          "this task is already finished",
          "invalid_transition"
        );
      }
      if (run.attention) {
        throw httpError(
          409,
          "this task is waiting for a reply; answer its attention instead",
          "attention_open"
        );
      }
      (run.guidance ??= []).push(text);
      // A note that lands on the last checkpoint needs one more to be used at all.
      if (run.iteration >= run.maxIterations) {
        run.maxIterations = run.iteration + 1;
      }
      await publish(run, {
        type: "goal_status",
        status: run.status,
        message: "Guidance added for the next worker checkpoint.",
      });
      return snapshot(run);
    },

    async stopGoal(thebeSessionId: string): Promise<GoalRun> {
      const run = runs.get(thebeSessionId);
      if (!run) throw new Error("no goal found for this session");
      if (run.status === "paused") {
        return setTerminal(run, "cancelled", "Goal cancelled while paused.");
      }
      if (run.status !== "running" && run.status !== "pausing") {
        return snapshot(run);
      }
      run.stopRequested = true;
      const active = run.activeSubagent;
      if (
        active &&
        (active.status === "queued" || active.status === "running")
      ) {
        await subagents.cancelSubagent(active.runId, run.thebeSessionId);
      }
      return snapshot(run);
    },

    clearGoal(thebeSessionId: string): void {
      const run = runs.get(thebeSessionId);
      if (!run) {
        void queueGoalPersistence(undefined, thebeSessionId);
        return;
      }
      if (run.status === "running" || run.status === "pausing") {
        throw new Error("stop or pause the goal before clearing it");
      }
      runs.delete(thebeSessionId);
      run.listeners.clear();
      void queueGoalPersistence(undefined, thebeSessionId);
    },
    watchdog,
  };
}

function storedGoalEvents(
  events: Array<{ event: GoalEvent; at: string }>
): StoredGoalEvent[] {
  return events.slice(-MAX_GOAL_EVENTS).map(toStoredGoalEvent);
}

function toStoredGoalEvent(row: {
  event: GoalEvent;
  at: string;
}): StoredGoalEvent {
  const event = row.event;
  switch (event.type) {
    case "goal_started":
      return {
        at: row.at,
        event: {
          type: event.type,
          goal: event.goal,
          criteria: event.criteria?.slice(),
          maxIterations: event.maxIterations,
        },
      };
    case "goal_iteration":
      return {
        at: row.at,
        event: {
          type: event.type,
          iteration: event.iteration,
          maxIterations: event.maxIterations,
        },
      };
    case "goal_reviewed":
      return {
        at: row.at,
        event: {
          type: event.type,
          iteration: event.iteration,
          complete: event.complete,
          score: event.score,
          critique: boundedText(event.critique, 400),
          remainingTasks: event.remainingTasks?.slice(),
        },
      };
    case "goal_completed":
      return {
        at: row.at,
        event: {
          type: event.type,
          status: event.status,
          totalIterations: event.totalIterations,
          summary: event.summary,
        },
      };
    case "goal_subagent_update":
      return {
        at: row.at,
        event: {
          type: event.type,
          iteration: event.iteration,
          role: event.role,
          run: {
            runId: event.run.runId,
            profileName: event.run.profileName,
            status: event.run.status,
          },
        },
      };
    case "goal_status":
      return {
        at: row.at,
        event: {
          type: event.type,
          status: event.status,
          message: event.message,
        },
      };
    case "goal_watchdog":
      return {
        at: row.at,
        event: {
          type: event.type,
          action: event.action,
          reason: event.reason,
          message: event.message,
        },
      };
  }
}

function restoreEvents(
  events: StoredGoalEvent[],
  parentSessionId: string
): Array<{ event: GoalEvent; at: string }> {
  return events
    .filter(
      (row) =>
        Boolean(row) &&
        typeof row.at === "string" &&
        Boolean(row.event) &&
        typeof row.event.type === "string"
    )
    .slice(-MAX_GOAL_EVENTS)
    .map((row) => ({
      at: row.at,
      event: restoreEvent(row.event, parentSessionId, row.at),
    }));
}

function restoreEvent(
  event: StoredGoalEvent["event"],
  parentSessionId: string,
  at: string
): GoalEvent {
  if (event.type !== "goal_subagent_update") {
    return event;
  }
  const run: SubagentRun = {
    runId: event.run.runId,
    parentSessionId,
    profileName: event.run.profileName,
    task: "",
    status: event.run.status,
    turns: 0,
    maxTurns: 0,
    createdAt: at,
  };
  return {
    type: event.type,
    iteration: event.iteration,
    role: event.role,
    run,
  };
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function personNotice(
  run: ManagedGoal
): Omit<GoalNeedsPersonNotice, "ticketId"> | undefined {
  if (run.status === "paused" && run.watchdog?.state === "waiting_for_person") {
    return {
      id: `${run.thebeSessionId}:watchdog:${run.watchdog.at}`,
      goalId: run.thebeSessionId,
      reason: "stalled",
      message:
        run.watchdog.summary ?? "A task stopped making progress and needs you.",
    };
  }
  if (run.status === "paused" && run.attention) {
    return {
      id: run.attention.id,
      goalId: run.thebeSessionId,
      reason: run.attention.kind,
      message:
        run.attention.kind === "review"
          ? "A task finished and is ready for your review."
          : "A task has a question for you.",
    };
  }
  if (run.status === "failed" && run.blocked) {
    const cleanError = run.error
      ? shortenToWords(stripToolLogs(run.error), 50)
      : "";
    return {
      id: `${run.thebeSessionId}:blocked:${run.finishedAt ?? run.createdAt}`,
      goalId: run.thebeSessionId,
      reason: "blocked",
      message: cleanError
        ? `A task is blocked and needs you: ${cleanError}`
        : "A task is blocked and needs you.",
    };
  }
  return undefined;
}

function completionNotice(
  run: ManagedGoal
): Omit<GoalCompletedNotice, "ticketId"> | undefined {
  if (run.status !== "completed") return undefined;
  const report = run.finalReport?.trim() || run.summary?.trim();
  const clean = report ? shortenToWords(stripToolLogs(report), 50) : "";
  return {
    id: `${run.thebeSessionId}:completed:${run.finishedAt ?? run.createdAt}`,
    goalId: run.thebeSessionId,
    message: clean ? `A task is complete: ${clean}` : "A task is complete.",
  };
}

function watchdogReasonText(reason: GoalWatchdogReason): string {
  switch (reason) {
    case "worker_inactivity":
      return "the worker stopped reporting activity";
    case "reviewer_inactivity":
      return "the reviewer stopped reporting activity";
    case "goal_no_progress":
      return "the task stopped making progress";
  }
}

function watchdogPauseMessage(reason: GoalWatchdogReason): string {
  return `Paused by Watchdog after ${watchdogReasonText(reason)}. It needs you to decide how to continue.`;
}

function clampIterations(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(50, Math.floor(value as number)));
}
