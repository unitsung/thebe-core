import { Editor, matchesKey, type TUI } from "../rendering/adapter.ts";
import type { ThebeAgent, ThinkingLevel } from "../../../agent/index.ts";
import type { ChatState } from "./state.ts";
import type { SessionDriver } from "./session-driver.ts";
import type { EventPresenter } from "./event-presenter.ts";
import type { TaskPresenter } from "./task-presenter.ts";
import { runChatBash } from "./bash.ts";

export type InputControllerDeps = {
  tui: TUI;
  editor: Editor;
  agent?: ThebeAgent;
  state: ChatState;
  sessions: SessionDriver;
  events: EventPresenter;
  tasks: TaskPresenter;
  handleSlash: (raw: string) => Promise<boolean>;
  clearMessagesView: () => void;
  notice: (text: string) => void;
  updateFooter: () => void;
  updateEditorBorderColor: () => void;
  workspacePath: string;
};

/** Owns editor submission, keyboard shortcuts, and the direct shell flow. */
export class InputController {
  private readonly thinkingCycle: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  private readonly originalHandleInput: (data: string) => void;

  constructor(private readonly deps: InputControllerDeps) {
    this.originalHandleInput = deps.editor.handleInput.bind(deps.editor);
  }

  bind(): void {
    const { editor } = this.deps;
    editor.onSubmit = (value) => void this.submit(value);
    editor.handleInput = (data) => this.handleInput(data);
  }

  private async submit(value: string): Promise<void> {
    const { state, editor, notice, tui } = this.deps;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed === "/clear") {
      this.deps.clearMessagesView();
      return;
    }
    if (trimmed.startsWith("!")) {
      const isExcluded = trimmed.startsWith("!!");
      const command = isExcluded ? trimmed.slice(2).trim() : trimmed.slice(1).trim();
      editor.setText("");
      state.isBashMode = false;
      this.deps.updateEditorBorderColor();
      if (!command) return;
      if (state.isExecutingBash) {
        notice("A bash command is already running. Press Esc to cancel it first.");
        return;
      }
      void this.runBash(command, isExcluded);
      return;
    }
    try {
      if (await this.deps.handleSlash(trimmed)) return;
      await this.deps.sessions.runPrompt(trimmed, "prompt");
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
      state.isResponding = false;
      editor.disableSubmit = false;
      this.deps.events.endStream();
    } finally {
      tui.setFocus(editor);
      tui.requestRender();
    }
  }

  private handleInput(data: string): void {
    const { state, editor, tui, agent, notice } = this.deps;
    if (matchesKey(data, "ctrl+shift+g")) return void this.deps.tasks.openLatestSubagent();
    if (matchesKey(data, "ctrl+g")) return void this.deps.tasks.openTaskPane();
    if (matchesKey(data, "ctrl+l") || matchesKey(data, "ctrl+p")) return void this.deps.handleSlash("/model");
    if (matchesKey(data, "ctrl+x")) return void this.deps.handleSlash("/copy");
    if (matchesKey(data, "shift+tab")) {
      void this.cycleThinking();
      return;
    }
    if (matchesKey(data, "ctrl+t")) {
      this.deps.events.setHideThinking(!state.hideThinking);
      return;
    }
    if (matchesKey(data, "ctrl+o")) {
      this.deps.events.setToolsExpanded(!state.toolsExpanded);
      return;
    }
    if (matchesKey(data, "escape")) {
      if (state.currentBashAbortController) return void state.currentBashAbortController.abort();
      if (state.isBashMode) {
        editor.setText("");
        state.isBashMode = false;
        this.deps.updateEditorBorderColor();
        this.deps.updateFooter();
        return;
      }
    }
    if (state.isResponding && (matchesKey(data, "alt+enter") || matchesKey(data, "ctrl+q"))) {
      const text = editor.getText().trim();
      if (text && agent && state.sessionId) {
        void agent.prompt(text, { thebeSessionId: state.sessionId, mode: "followUp" })
          .then(() => {
            notice(`queued follow-up: ${text}`);
            editor.setText("");
          })
          .catch((error: unknown) => notice(error instanceof Error ? error.message : String(error)));
        return;
      }
    }
    this.originalHandleInput(data);
    this.deps.updateFooter();
  }

  private async cycleThinking(): Promise<void> {
    const { state, agent, notice } = this.deps;
    try {
      if (agent && state.sessionId) {
        await state.thinkingSyncPromise;
        const levels = state.thinkingInfo.availableLevels.length > 0 ? state.thinkingInfo.availableLevels : this.thinkingCycle;
        const index = levels.indexOf(state.currentThinking);
        await this.deps.sessions.setThinkingLevel(levels[(index < 0 ? 0 : index + 1) % levels.length]!);
      } else {
        const index = this.thinkingCycle.indexOf(state.currentThinking);
        state.currentThinking = this.thinkingCycle[(index < 0 ? 0 : index + 1) % this.thinkingCycle.length]!;
        this.deps.updateFooter();
        this.deps.updateEditorBorderColor();
      }
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
      state.thinkingSyncPromise = this.deps.sessions.syncThinkingLevel(state.sessionId);
    }
  }

  private async runBash(command: string, excludeFromContext: boolean): Promise<void> {
    const { state, tui, notice } = this.deps;
    state.isExecutingBash = true;
    this.deps.updateEditorBorderColor();
    const controller = new AbortController();
    state.currentBashAbortController = controller;
    try {
      const sessionId = this.deps.agent ? await this.deps.sessions.ensureSession() : state.sessionId;
      await runChatBash(
        { tui, insertBeforeFooter: (component) => this.deps.events.insertBeforeFooter(component), notice },
        command,
        excludeFromContext,
        { agent: this.deps.agent, sessionId, signal: controller.signal, onData: () => {}, cwd: this.deps.workspacePath },
      );
    } finally {
      state.currentBashAbortController = undefined;
      state.isExecutingBash = false;
      this.deps.tasks.flushGoalConclusions();
      this.deps.updateEditorBorderColor();
      tui.requestRender();
    }
  }
}
