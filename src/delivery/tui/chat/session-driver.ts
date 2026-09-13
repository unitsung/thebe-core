import type { RuntimeThinkingInfo, ThebeAgent, ThinkingLevel } from "../../../agent/index.ts";
import type { Markdown, Editor, TUI, Component } from "../rendering/adapter.ts";
import type { ThebeTuiOptions } from "../types.ts";
import { parseModelRef } from "../overlays/model-ref.ts";
import { readMarkdownSource } from "../display/markdown-source.ts";
import { ChatState } from "./state.ts";
import { EventPresenter } from "./event-presenter.ts";
import { TaskPresenter } from "./task-presenter.ts";
import type { FooterDock } from "../display/footer.ts";
import { formatGoalConclusion } from "../display/goal.ts";

export type SessionDriverDeps = {
  tui: TUI;
  editor: Editor;
  footerText: FooterDock;
  agent?: ThebeAgent;
  options: ThebeTuiOptions;
  state: ChatState;
  events: EventPresenter;
  tasks: TaskPresenter;
  makeMarkdown: (text: string) => Markdown;
  updateFooter: () => void;
  updateEditorBorderColor: () => void;
  notice: (text: string) => void;
  workspacePath: string;
  insertBeforeFooter: (component: Component) => void;
};

/** Owns Agent session lifecycle, prompt delivery, summaries, and history. */
export class SessionDriver {
  private readonly deps: SessionDriverDeps;

  constructor(deps: SessionDriverDeps) {
    this.deps = deps;
  }

  async ensureSession(): Promise<string> {
    const { state, agent, options } = this.deps;
    if (!state.sessionId && agent) state.sessionId = agent.lastThebeSessionId();
    if (state.sessionId) return state.sessionId;
    if (!agent) throw new Error("no active session; use /new");
    if (!state.sessionCreationPromise) {
      state.sessionCreationPromise = (async () => {
        const parsed = parseModelRef(state.currentModel);
        const meta = await agent.createSession({
          title: state.sessionTitle ?? options.title,
          model: parsed.providerId && parsed.modelId
            ? { providerId: parsed.providerId, modelId: parsed.modelId }
            : undefined,
        });
        state.sessionId = meta.thebeSessionId;
        state.sessionTitle = meta.title;
        this.subscribeSummary(state.sessionId);
        this.deps.tasks.subscribe(state.sessionId);
        state.thinkingSyncPromise = this.syncThinkingLevel(state.sessionId);
        void this.refreshContextUsage();
        this.deps.updateFooter();
        return meta.thebeSessionId;
      })();
    }
    const pending = state.sessionCreationPromise;
    try {
      return await pending;
    } finally {
      if (state.sessionCreationPromise === pending) state.sessionCreationPromise = undefined;
    }
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<RuntimeThinkingInfo> {
    if (!this.deps.agent) return this.deps.state.thinkingInfo;
    const id = await this.ensureSession();
    this.deps.state.thinkingInfo = await this.deps.agent.setThinkingLevel(id, level);
    this.deps.state.currentThinking = this.deps.state.thinkingInfo.level;
    this.deps.updateFooter();
    this.deps.updateEditorBorderColor();
    return this.deps.state.thinkingInfo;
  }

  async syncThinkingLevel(thebeSessionId = this.deps.state.sessionId): Promise<void> {
    const { state, agent } = this.deps;
    if (state.disposed || !agent || !thebeSessionId) return;
    try {
      const info = await agent.getThinkingInfo(thebeSessionId);
      if (state.disposed || thebeSessionId !== state.sessionId) return;
      state.thinkingInfo = info;
      state.currentThinking = info.level;
      this.deps.updateFooter();
      this.deps.updateEditorBorderColor();
    } catch {
      // A session may disappear during a renderer handoff.
    }
  }

  async refreshContextUsage(): Promise<void> {
    const { state, agent } = this.deps;
    const id = state.sessionId;
    if (state.disposed || !agent || !id) return;
    try {
      const usage = await agent.getContextUsage(id);
      if (state.disposed || id !== state.sessionId) return;
      state.contextTokensUsed = usage.contextUsage.usedTokens;
      state.contextWindowTotal = usage.contextUsage.maxTokens;
      this.deps.updateFooter();
    } catch {
      // Usage is supplemental UI state.
    }
  }

  async runPrompt(text: string, mode: "prompt" | "steer" | "followUp" = "prompt"): Promise<void> {
    const { state, agent, options, editor, events, tui } = this.deps;
    if (!agent) {
      if (!options.send) throw new Error("TUI requires agent or send");
      state.isResponding = true;
      this.deps.updateEditorBorderColor();
      editor.disableSubmit = true;
      this.deps.insertBeforeFooter(this.deps.makeMarkdown(text));
      events.beginStream();
      try {
        const reply = await options.send(text);
        if (state.replyMarkdown) {
          const index = tui.children.indexOf(state.replyMarkdown);
          if (index >= 0) tui.children[index] = this.deps.makeMarkdown(reply);
        }
      } finally {
        events.endStream();
        state.isResponding = false;
        this.deps.tasks.flushGoalConclusions();
        editor.disableSubmit = false;
        this.deps.updateFooter();
        this.deps.updateEditorBorderColor();
        tui.requestRender();
      }
      return;
    }
    const id = await this.ensureSession();
    if (mode !== "prompt") {
      await agent.prompt(text, { thebeSessionId: id, mode });
      this.deps.notice(`${mode}: ${text}`);
      return;
    }
    if (state.isResponding) {
      await agent.prompt(text, { thebeSessionId: id, mode: "steer" });
      this.deps.notice(`steered: ${text}`);
      return;
    }
    state.isResponding = true;
    this.deps.updateEditorBorderColor();
    this.deps.insertBeforeFooter(this.deps.makeMarkdown(text));
    events.beginStream();
    state.streamUnsub = agent.subscribeLog(id, (event) => events.onEvent(event));
    try {
      const result = await agent.prompt(text, { thebeSessionId: id, mode: "prompt" });
      if (state.replyMarkdown && !readMarkdownSource(state.replyMarkdown)) {
        const index = tui.children.indexOf(state.replyMarkdown);
        if (index >= 0) tui.children[index] = this.deps.makeMarkdown(result.text);
      } else if (!state.replyMarkdown && result.text) {
        events.insertBeforeWorking(this.deps.makeMarkdown(result.text));
      }
    } catch (error) {
      this.deps.notice(error instanceof Error ? error.message : String(error));
    } finally {
      events.endStream();
      state.isResponding = false;
      this.deps.tasks.flushGoalConclusions();
      void this.refreshContextUsage();
      this.deps.updateFooter();
      this.deps.updateEditorBorderColor();
      tui.requestRender();
    }
  }

  async loadAndDisplaySessionHistory(thebeId: string): Promise<void> {
    const { state, agent, events, footerText, tui } = this.deps;
    if (!agent) return;
    events.clearMessagesView();
    const generation = state.historyLoadGeneration;
    try {
      const messages = await agent.loadMessages(thebeId);
      if (!this.isCurrent(thebeId, generation)) return;
      events.displayHistory(messages);
      try {
        const meta = await agent.getSession(thebeId);
        if (!this.isCurrent(thebeId, generation)) return;
        footerText.setSummary(meta.lastSummary);
      } catch {
        // Session metadata is optional to the transcript.
      }
      const goal = agent.getGoal(thebeId);
      if (goal) {
        state.currentGoalRun = goal;
        this.deps.tasks.watchGoal(thebeId);
        this.deps.tasks.updateGoalStatus(goal);
        if (isFinishedGoal(goal)) {
          events.insertBeforeFooter(this.deps.makeMarkdown(formatGoalConclusion(goal)));
        }
      }
      tui.requestRender();
    } catch {
      // Loading a stale session should not tear down the live TUI.
    }
  }

  switchSession(value: string | undefined): void {
    const { state, agent, footerText } = this.deps;
    if (state.sessionId !== value) {
      state.streamUnsub?.();
      state.streamUnsub = undefined;
      this.deps.tasks.dispose();
      state.pendingGoalConclusions.length = 0;
      state.currentGoalRun = undefined;
      footerText.setTaskStatus(undefined);
    }
    state.sessionId = value;
    footerText.setSummary(undefined);
    this.subscribeSummary(value);
    this.deps.tasks.subscribe(value);
    state.thinkingSyncPromise = this.syncThinkingLevel(value);
  }

  dispose(): void {
    this.deps.state.summaryUnsub?.();
    this.deps.state.summaryUnsub = undefined;
  }

  private subscribeSummary(thebeSessionId?: string): void {
    const { state, agent } = this.deps;
    state.summaryUnsub?.();
    state.summaryUnsub = undefined;
    if (!agent || !thebeSessionId) return;
    state.summaryUnsub = agent.subscribeLog(thebeSessionId, (event) => {
      if (event.type === "summary_ready") this.deps.events.onEvent(event);
    });
  }

  private isCurrent(id: string, generation: number): boolean {
    const { state } = this.deps;
    return !state.disposed && state.historyLoadGeneration === generation && state.sessionId === id;
  }
}

function isFinishedGoal(run: { status: string }): boolean {
  return ["completed", "max_iterations", "cancelled", "failed"].includes(run.status);
}
