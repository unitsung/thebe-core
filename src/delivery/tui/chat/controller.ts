/**
 * Public chat seam. The implementation is deliberately wiring-heavy: state,
 * Agent session flow, event rendering, task rendering, and editor input
 * each live behind their own deep internal module.
 */
import {
  CombinedAutocompleteProvider,
  Editor,
  Markdown,
  Text,
  type SelectListTheme,
  type TUI,
} from "../rendering/adapter.ts";
import { initTheme, truncateToWidth } from "../rendering/adapter.ts";
import type { ThebeTuiOptions } from "../types.ts";
import {
  chalk,
  getTuiTheme,
  getThinkingBorderColor,
  getBashModeBorderColor,
  getRunningBorderColor,
  type ThemeName,
} from "../theme.ts";
import { loadThebeConfig, saveThebeConfig } from "../settings/config.ts";
import { slashCommandsForAutocomplete } from "../commands/registry.ts";
import { getGitBranch, renderStartScreen } from "../display/format.ts";
import { FooterDock } from "../display/footer.ts";
import { formatFooterLines } from "./footer.ts";
import { readMarkdownSource } from "../display/markdown-source.ts";
import { makeReplyMarkdown } from "./transcript.ts";
import { dispatchSlash, type SlashHost } from "../commands/index.ts";
import { runCustomProviderWizard as runCustomProviderWizardFlow } from "../auth/wizard.ts";
import { ChatState } from "./state.ts";
import { EventPresenter } from "./event-presenter.ts";
import { SessionDriver } from "./session-driver.ts";
import { TaskPresenter } from "./task-presenter.ts";
import { InputController } from "./input-controller.ts";

export type ChatHandle = {
  editor: Editor;
  updateFooter: () => void;
  handleSlash: (raw: string) => Promise<boolean>;
  isResponding: () => boolean;
  isExecutingBash: () => boolean;
  abortBash: () => void;
  toggleThinking: () => void;
  toggleTools: () => void;
  dispose: () => void;
  getSessionState: () => { sessionId: string | undefined; title: string | undefined; model: string };
};

export function attachThebeChat(tui: TUI, options: ThebeTuiOptions): ChatHandle {
  const agent = options.agent;
  const state = new ChatState(options);
  const workspacePath = options.cwd ?? agent?.workspacePath ?? process.cwd();
  try {
    initTheme(state.currentTheme, false);
  } catch {
    // Rendering is still usable when a terminal theme cannot be initialized.
  }

  const cachedBranch = getGitBranch(workspacePath);
  const startScreen = new Text(renderStartScreen({
    version: options.version ?? "0.1.0",
    model: state.currentModel,
    cwd: workspacePath,
    branch: cachedBranch,
    width: tui.terminal?.columns ?? process.stdout.columns ?? 80,
    sessionTitle: state.sessionTitle,
  }));
  tui.addChild(startScreen);

  const editor = new Editor(tui, getTuiTheme(state.currentTheme).editor);
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommandsForAutocomplete(), workspacePath));
  tui.addChild(editor);
  tui.setFocus(editor);
  const footerText = new FooterDock();
  tui.addChild(footerText);

  const updateEditorBorderColor = (): void => {
    if (state.disposed) return;
    editor.borderColor = state.isBashMode
      ? getBashModeBorderColor(state.currentTheme)
      : state.isResponding || state.isExecutingBash
        ? getRunningBorderColor(state.currentTheme)
        : getThinkingBorderColor(state.currentThinking, state.currentTheme);
    editor.invalidate();
    tui.requestRender();
  };

  const updateFooter = (): void => {
    if (state.disposed) return;
    const width = tui.terminal?.columns ?? process.stdout.columns ?? 80;
    const home = process.env.HOME || process.env.USERPROFILE;
    const isMenuOpen = editor.isShowingAutocomplete?.() ?? false;
    footerText.setText(formatFooterLines({
      width,
      cwd: workspacePath,
      home,
      branch: cachedBranch,
      sessionTitle: state.sessionTitle,
      inputTokens: state.cumulativeInputTokens,
      outputTokens: state.cumulativeOutputTokens,
      contextUsed: state.contextTokensUsed,
      contextWindow: state.contextWindowTotal,
      model: state.currentModel,
      thinking: state.currentThinking,
      isResponding: state.isResponding,
      activeToolName: state.activeToolName,
      isBashMode: state.isBashMode,
      isExecutingBash: state.isExecutingBash,
      isMenuOpen,
    }).join("\n"));
    tui.requestRender();
  };

  const makeMarkdown = (text: string): Markdown =>
    makeReplyMarkdown(text, getTuiTheme(state.currentTheme).markdown);
  const notice = (text: string): void => {
    if (state.disposed) return;
    const width = tui.terminal?.columns ?? process.stdout.columns ?? 80;
    const fitted = text.split("\n").map((line) => truncateToWidth(line, width, "")).join("\n");
    events.insertBeforeFooter(new Text(chalk.dim(fitted)));
  };

  const getActiveSelectListTheme = (): SelectListTheme => getTuiTheme(state.currentTheme).selectList;
  let sessions!: SessionDriver;
  const tasks = new TaskPresenter({
    tui,
    agent,
    state,
    footerText,
    notice,
    insertBeforeFooter: (component) => events.insertBeforeFooter(component),
    makeMarkdown,
    onEvent: (event) => events.onEvent(event),
  });
  const events = new EventPresenter({
    tui,
    agent,
    state,
    editor,
    startScreen,
    footerText,
    workspacePath,
    notice,
    updateFooter,
    updateEditorBorderColor,
    refreshContextUsage: () => sessions.refreshContextUsage(),
    getActiveSelectListTheme,
    getSessionId: () => state.sessionId,
    makeMarkdown,
    persistHideThinking: (hidden) => {
      void saveThebeConfig({ hideThinking: hidden }).catch((error) => {
        notice(
          `hide-thinking setting was not saved: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    },
  });
  sessions = new SessionDriver({
    tui,
    editor,
    footerText,
    agent,
    options,
    state,
    events,
    tasks,
    makeMarkdown,
    updateFooter,
    updateEditorBorderColor,
    notice,
    workspacePath,
    insertBeforeFooter: (component) => events.insertBeforeFooter(component),
  });

  editor.onChange = (text) => {
    const wasBashMode = state.isBashMode;
    state.isBashMode = text.trimStart().startsWith("!");
    if (wasBashMode !== state.isBashMode) updateEditorBorderColor();
    updateFooter();
  };
  updateEditorBorderColor();

  const host: SlashHost = {
    tui,
    editor,
    options,
    get agent() { return agent; },
    get sessionId() { return state.sessionId; },
    set sessionId(value) { sessions.switchSession(value); },
    get sessionTitle() { return state.sessionTitle; },
    set sessionTitle(value) { state.sessionTitle = value; },
    get currentModel() { return state.currentModel; },
    set currentModel(value) { state.currentModel = value; },
    get currentThinking() { return state.currentThinking; },
    set currentThinking(value) {
      state.currentThinking = value;
      state.thinkingInfo = { ...state.thinkingInfo, level: value };
    },
    get currentTheme() { return state.currentTheme; },
    set currentTheme(value) { state.currentTheme = value; },
    get contextTokensUsed() { return state.contextTokensUsed; },
    get contextWindowTotal() { return state.contextWindowTotal; },
    get pendingPermissionId() { return state.pendingPermissionId; },
    set pendingPermissionId(value) { state.pendingPermissionId = value; },
    children: tui.children,
    footerText,
    notice,
    ensureSession: () => sessions.ensureSession(),
    loadAndDisplaySessionHistory: (id) => sessions.loadAndDisplaySessionHistory(id),
    clearMessagesView: () => events.clearMessagesView(),
    refreshContextUsage: () => sessions.refreshContextUsage(),
    updateFooter,
    updateEditorBorderColor,
    setHideThinking: (hidden) => {
      events.setHideThinking(hidden);
    },
    setThinkingLevel: (level) => sessions.setThinkingLevel(level),
    applyTheme: (name, persist = true) => applyTheme(name, persist),
    applyModel: (id, selected) => applyModel(id, selected),
    insertBeforeFooter: (component) => events.insertBeforeFooter(component as never),
    makeMarkdown,
    getActiveSelectListTheme,
    runCustomProviderWizard: (initial) => runCustomProviderWizard(initial),
    afterProviderLoggedIn,
    updateGoalStatus: (run, event) => tasks.updateGoalStatus(run, event),
    watchGoal: (id) => tasks.watchGoal(id),
    clearGoalStatus: () => tasks.clearGoalStatus(),
    showGoalConclusion: (run, id) => tasks.showGoalConclusion(run, id),
    openTaskPane: () => tasks.openTaskPane(),
    forwardRuntimeEvent: (event) => events.onEvent(event),
  };

  async function applyTheme(name: ThemeName, persist = true): Promise<void> {
    if (state.disposed) return;
    state.currentTheme = name;
    try { initTheme(name, false); } catch {}
    (editor as unknown as { theme: unknown }).theme = getTuiTheme(name).editor;
    updateEditorBorderColor();
    for (const child of tui.children) child.invalidate?.();
    for (let i = 0; i < tui.children.length; i++) {
      const child = tui.children[i];
      if (!(child instanceof Markdown)) continue;
      const replacement = makeMarkdown(readMarkdownSource(child));
      tui.children[i] = replacement;
      if (state.replyMarkdown === child) state.replyMarkdown = replacement;
    }
    if (persist) await saveThebeConfig({ theme: name });
    tui.requestRender();
  }

  async function applyModel(id: string, selected: { providerId: string; modelId: string; displayName?: string }): Promise<void> {
    if (!agent) return;
    await agent.setModel(id, { providerId: selected.providerId, modelId: selected.modelId });
    await sessions.syncThinkingLevel(id);
    state.currentModel = `${selected.providerId}/${selected.modelId}`;
    void sessions.refreshContextUsage();
    updateFooter();
    notice(`switched model to ${state.currentModel} (${selected.displayName ?? selected.modelId})`);
  }

  async function runCustomProviderWizard(initialProviderId?: string): Promise<{ providerId: string; modelId: string } | null> {
    if (!agent) return null;
    return runCustomProviderWizardFlow({ tui, editor, agent, notice, getActiveSelectListTheme }, initialProviderId);
  }

  async function afterProviderLoggedIn(providerId: string, actionLabel: string, preferredModelId?: string): Promise<void> {
    if (!agent || !state.sessionId) return notice(actionLabel);
    const models = await agent.listAvailableModels({ providerId });
    if (models.length === 0) return notice(`${actionLabel}. no models available for ${providerId}; use /model after models appear`);
    const target = (preferredModelId ? models.find((model) => model.modelId === preferredModelId) : undefined) ?? models[0]!;
    await applyModel(state.sessionId, target);
    notice(`${actionLabel}. selected ${target.providerId}/${target.modelId}`);
  }

  const handleSlash = (raw: string): Promise<boolean> => dispatchSlash(host, raw);
  const input = new InputController({
    tui,
    editor,
    agent,
    state,
    sessions,
    events,
    tasks,
    handleSlash,
    clearMessagesView: () => events.clearMessagesView(),
    notice,
    updateFooter,
    updateEditorBorderColor,
    workspacePath,
  });
  input.bind();

  void loadThebeConfig().then((config) => {
    state.hideThinking = config.hideThinking ?? true;
  });
  sessions.switchSession(state.sessionId);
  void sessions.refreshContextUsage();
  updateFooter();
  if (state.sessionId && agent) void sessions.loadAndDisplaySessionHistory(state.sessionId);

  return {
    editor,
    updateFooter,
    handleSlash,
    isResponding: () => state.isResponding,
    isExecutingBash: () => state.isExecutingBash,
    abortBash: () => state.currentBashAbortController?.abort(),
    toggleThinking: () => {
      events.setHideThinking(!state.hideThinking);
    },
    toggleTools: () => events.setToolsExpanded(!state.toolsExpanded),
    dispose: () => {
      if (state.disposed) return;
      state.disposed = true;
      sessions.dispose();
      tasks.dispose();
      events.clearMessagesView();
    },
    getSessionState: () => ({ sessionId: state.sessionId, title: state.sessionTitle, model: state.currentModel }),
  };
}
