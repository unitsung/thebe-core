import type { GoalEvent, GoalRun, SubagentRun, ThebeAgent } from "../../../agent/index.ts";
import type { Component, Markdown, TUI } from "../rendering/adapter.ts";
import type { NormalizedEvent } from "../../../agent/index.ts";
import { formatGoalConclusion } from "../display/goal.ts";
import type { FooterDock } from "../display/footer.ts";
import { showSubagentDetail } from "../overlays/subagent-detail.ts";
import { showTaskPane } from "../overlays/task-pane.ts";
import { ChatState } from "./state.ts";

export type TaskPresenterDeps = {
  tui: TUI;
  agent?: ThebeAgent;
  state: ChatState;
  footerText: FooterDock;
  notice: (text: string) => void;
  insertBeforeFooter: (component: Component) => void;
  makeMarkdown: (text: string) => Markdown;
  onEvent: (event: NormalizedEvent) => void;
};

/** Owns Agent control-plane task subscriptions and their persistent TUI presentation. */
export class TaskPresenter {
  private subagentUnsub: (() => void) | undefined;
  private goalUnsub: (() => void) | undefined;
  private taskPaneClose: (() => void) | undefined;
  private childDetailClose: (() => void) | undefined;
  private readonly runsBySession = new Map<string, SubagentRun[]>();

  constructor(private readonly deps: TaskPresenterDeps) {}

  async refreshTaskDock(): Promise<void> {
    const { agent, state } = this.deps;
    if (!agent || !state.sessionId) {
      this.deps.footerText.setTaskStatus(undefined);
      return;
    }
    const sessionId = state.sessionId;
    const goal = agent.getGoal(sessionId) ?? state.currentGoalRun;
    this.renderTaskDock(sessionId, goal, this.runsBySession.get(sessionId) ?? []);
    let runs: SubagentRun[];
    try {
      runs = await agent.listSubagents(sessionId);
    } catch {
      return;
    }
    if (state.sessionId !== sessionId) return;
    this.runsBySession.set(sessionId, runs);
    this.renderTaskDock(sessionId, agent.getGoal(sessionId) ?? state.currentGoalRun, runs);
  }

  private renderTaskDock(
    _sessionId: string,
    goal: GoalRun | undefined,
    runs: SubagentRun[],
  ): void {
    const { footerText, tui } = this.deps;
    if (!goal && runs.length === 0) {
      footerText.setTaskStatus(undefined);
      tui.requestRender();
      return;
    }
    const active = runs.find((run) => run.status === "running" || run.status === "queued");
    const latest = active ?? runs.at(-1);
    const parts = [
      goal ? `Goal ${goal.status} ${goal.iteration}/${goal.maxIterations}` : undefined,
      latest ? `${latest.profileName} ${latest.status} ${latest.turns}/${latest.maxTurns}` : undefined,
      `${runs.length} child${runs.length === 1 ? "" : "ren"}`,
    ].filter(Boolean);
    footerText.setTaskStatus(parts.join(" · "), () => {
      void this.openTaskPane();
    });
    tui.requestRender();
  }

  subscribe(thebeSessionId?: string): void {
    this.subagentUnsub?.();
    this.subagentUnsub = undefined;
    if (!this.deps.agent || !thebeSessionId) {
      void this.refreshTaskDock();
      return;
    }
    this.subagentUnsub = this.deps.agent.subscribeSubagents(thebeSessionId, () => {
      void this.refreshTaskDock();
    });
    void this.refreshTaskDock();
  }

  watchGoal(thebeSessionId: string): void {
    this.goalUnsub?.();
    this.goalUnsub = undefined;
    const { agent } = this.deps;
    if (!agent) return;
    this.goalUnsub = agent.subscribeGoal(thebeSessionId, (event) => {
      const run = agent.getGoal(thebeSessionId);
      if (!run) return;
      if (event.type === "goal_subagent_update" && event.event?.type === "permission_requested") {
        this.deps.onEvent(event.event);
      }
      this.updateGoalStatus(run, event);
    });
  }

  updateGoalStatus(run: GoalRun, _event?: GoalEvent): void {
    this.deps.state.currentGoalRun = run;
    void this.refreshTaskDock();
  }

  clearGoalStatus(): void {
    this.goalUnsub?.();
    this.goalUnsub = undefined;
    this.deps.state.currentGoalRun = undefined;
    void this.refreshTaskDock();
  }

  showGoalConclusion(run: GoalRun, targetSessionId: string): void {
    const { state, notice } = this.deps;
    if (state.sessionId !== targetSessionId) {
      notice(`goal ${run.status} · switch back to ${targetSessionId.slice(0, 8)} to inspect the conclusion`);
    } else if (state.isResponding || state.isExecutingBash) {
      state.pendingGoalConclusions.push({ run, sessionId: targetSessionId });
    } else {
      this.deps.insertBeforeFooter(this.deps.makeMarkdown(formatGoalConclusion(run)));
    }
    this.deps.tui.requestRender();
  }

  flushGoalConclusions(): void {
    const { state, notice, insertBeforeFooter, makeMarkdown, tui } = this.deps;
    if (state.isResponding || state.isExecutingBash || state.pendingGoalConclusions.length === 0) return;
    const pending = state.pendingGoalConclusions.splice(0);
    for (const item of pending) {
      if (state.sessionId !== item.sessionId) {
        notice(`goal ${item.run.status} · switch back to ${item.sessionId.slice(0, 8)} to inspect the conclusion`);
      } else {
        insertBeforeFooter(makeMarkdown(formatGoalConclusion(item.run)));
      }
    }
    tui.requestRender();
  }

  async openTaskPane(): Promise<void> {
    if (this.taskPaneClose) {
      this.taskPaneClose();
      this.taskPaneClose = undefined;
      return;
    }
    const { agent, state, notice, tui } = this.deps;
    const id = state.sessionId ?? agent?.lastThebeSessionId();
    if (!agent || !id) return notice("no Goal or subagent tasks yet");
    let runs: SubagentRun[];
    try {
      runs = await agent.listSubagents(id);
    } catch {
      return notice("no Goal or subagent tasks yet");
    }
    if (state.sessionId && state.sessionId !== id) return;
    if (!agent.getGoal(id) && runs.length === 0) return notice("no Goal or subagent tasks yet");
    this.taskPaneClose = showTaskPane(tui, agent, id, () => {
      this.taskPaneClose = undefined;
    }, (run) => this.openSubagentDetail(run), runs);
  }

  async openLatestSubagent(): Promise<void> {
    const { agent, state, notice } = this.deps;
    const id = state.sessionId ?? agent?.lastThebeSessionId();
    if (!agent || !id) return notice("no subagent runs yet");
    let runs: SubagentRun[];
    try {
      runs = await agent.listSubagents(id);
    } catch {
      return notice("no subagent runs yet");
    }
    const run = runs.find((item) => item.status === "running" || item.status === "queued") ?? runs.at(-1);
    if (!run) return notice("no subagent runs yet");
    this.openSubagentDetail(run);
  }

  dispose(): void {
    this.goalUnsub?.();
    this.subagentUnsub?.();
    this.taskPaneClose?.();
    this.childDetailClose?.();
    this.goalUnsub = undefined;
    this.subagentUnsub = undefined;
    this.taskPaneClose = undefined;
    this.childDetailClose = undefined;
  }

  private openSubagentDetail(run: SubagentRun): void {
    this.taskPaneClose?.();
    this.taskPaneClose = undefined;
    this.childDetailClose?.();
    this.childDetailClose = showSubagentDetail(this.deps.tui, this.deps.agent!, run);
  }
}
