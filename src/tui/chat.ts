/**
 * Chat shell: transcript, editor, footer, prompt, and slash dispatch.
 */
import { initTheme, ToolExecutionComponent } from "../runtime/pi/official-ui.ts";
import {
  CombinedAutocompleteProvider,
  Editor,
  Markdown,
  ProcessTerminal,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  matchesKey,
  truncateToWidth,
  type SelectListTheme,
  type TUI,
  type TuiMode,
} from "@earendil-works/pi-tui";
import type {
  NormalizedEvent,
  ThinkingLevel,
} from "../runtime/types.ts";
import {
  chalk,
  getTuiTheme,
  getThinkingBorderColor,
  getBashModeBorderColor,
  getRunningBorderColor,
  type ThemeName,
} from "./theme.ts";
import { loadThebeConfig, saveThebeConfig } from "./config.ts";
import type { ThebeTuiOptions } from "./types.ts";
import { slashCommandsForAutocomplete } from "./slash.ts";
import { getGitBranch, renderStartScreen } from "./display/format.ts";
import { FooterDock } from "./display/footer.ts";
import { attachSelectList } from "./overlays/index.ts";
import { runCustomProviderWizard as runCustomProviderWizardFlow } from "./providers/wizard.ts";
import { dispatchSlash, type SlashHost } from "./commands/index.ts";
import { readMarkdownSource, stashMarkdownSource } from "./display/markdown-source.ts";
import { runChatBash } from "./chat/bash.ts";
import { formatFooterLines } from "./chat/footer.ts";
import {
  ElapsedWorking,
  ThinkingBlock,
  createToolComponent,
  makeReplyMarkdown,
  toolResultPayload,
} from "./chat/transcript.ts";

export type ChatHandle = {
  editor: Editor;
  updateFooter: () => void;
  handleSlash: (raw: string) => Promise<boolean>;
  isResponding: () => boolean;
  isExecutingBash: () => boolean;
  abortBash: () => void;
};

export function attachThebeChat(
  tui: TUI,
  options: ThebeTuiOptions,
): ChatHandle {
  const product = options.product;
  let sessionId = options.sessionId;
  let sessionTitle = options.title;
  let currentModel = options.model ?? "";
  let currentThinking: ThinkingLevel = "off";
  let currentTheme: ThemeName = options.theme ?? "dark";
  try {
    initTheme(currentTheme, false);
  } catch {}
  let contextTokensUsed = 0;
  let contextWindowTotal = 1_048_576;
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let activeToolName: string | undefined;
  const cachedBranch = getGitBranch();

  const appVersion = options.version ?? "0.1.0";
  const initialWidth = tui.terminal?.columns ?? process.stdout.columns ?? 80;
  tui.addChild(
    new Text(
      renderStartScreen({
        version: appVersion,
        model: currentModel,
        cwd: process.cwd(),
        branch: cachedBranch,
        width: initialWidth,
        sessionTitle,
      }),
    ),
  );

  const editor = new Editor(tui, getTuiTheme(currentTheme).editor);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommandsForAutocomplete(), process.cwd()),
  );
  tui.addChild(editor);
  tui.setFocus(editor);

  const footerText = new FooterDock();
  tui.addChild(footerText);

  let isResponding = false;
  let isBashMode = false;
  let isExecutingBash = false;
  let currentBashAbortController: AbortController | undefined;
  let streamUnsub: (() => void) | undefined;
  let replyMarkdown: Markdown | undefined;
  let working: ElapsedWorking | undefined;
  let thinkingBlock: ThinkingBlock | undefined;
  let hideThinking = false;
  let toolsExpanded = false;
  const toolComponents = new Map<string, ToolExecutionComponent>();
  let pendingPermissionId: string | undefined;
  void loadThebeConfig().then((cfg) => {
    hideThinking = cfg.hideThinking ?? false;
  });

  const children = tui.children;

  function updateEditorBorderColor(): void {
    if (isBashMode) {
      editor.borderColor = getBashModeBorderColor(currentTheme);
    } else if (isResponding || isExecutingBash) {
      editor.borderColor = getRunningBorderColor(currentTheme);
    } else {
      editor.borderColor = getThinkingBorderColor(currentThinking, currentTheme);
    }
    editor.invalidate();
    tui.requestRender();
  }

  editor.onChange = (text: string) => {
    const wasBashMode = isBashMode;
    isBashMode = text.trimStart().startsWith("!");
    if (wasBashMode !== isBashMode) {
      updateEditorBorderColor();
    }
    updateFooter();
  };
  const origEditorHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    origEditorHandleInput(data);
    updateFooter();
    queueMicrotask(() => updateFooter());
    setTimeout(() => updateFooter(), 20);
  };
  updateEditorBorderColor();

  async function runBash(command: string, excludeFromContext: boolean): Promise<void> {
    isExecutingBash = true;
    updateEditorBorderColor();
    const abortController = new AbortController();
    currentBashAbortController = abortController;
    try {
      await runChatBash(
        { tui, insertBeforeFooter, notice },
        command,
        excludeFromContext,
        {
          product,
          sessionId,
          signal: abortController.signal,
          onData: () => {},
        },
      );
    } finally {
      currentBashAbortController = undefined;
      isExecutingBash = false;
      updateEditorBorderColor();
      tui.requestRender();
    }
  }

  function updateFooter(): void {
    const width = tui.terminal?.columns ?? process.stdout.columns ?? 80;
    const home = process.env.HOME || process.env.USERPROFILE;
    const isMenuOpen = editor.isShowingAutocomplete?.() ?? false;
    const lines = formatFooterLines({
      width,
      cwd: process.cwd(),
      home,
      branch: cachedBranch,
      sessionTitle,
      inputTokens: cumulativeInputTokens,
      outputTokens: cumulativeOutputTokens,
      contextUsed: contextTokensUsed,
      contextWindow: contextWindowTotal,
      model: currentModel,
      thinking: currentThinking,
      isResponding,
      activeToolName,
      isBashMode,
      isExecutingBash,
      isMenuOpen,
    });
    footerText.setText(lines.join("\n"));
    tui.requestRender();
  }

  function insertChatComponent(component: { render(width: number): string[] }): void {
    const index = children.indexOf(editor);
    const insertAt = index >= 0 ? index : Math.max(0, children.length - 1);
    children.splice(insertAt, 0, component as never);
    tui.requestRender();
  }

  function notice(text: string): void {
    const width = tui.terminal?.columns ?? process.stdout.columns ?? 80;
    const fitted = text
      .split("\n")
      .map((line) => truncateToWidth(line, width, ""))
      .join("\n");
    insertChatComponent(new Text(chalk.dim(fitted)));
  }

  async function applyModel(
    id: string,
    selected: { providerId: string; modelId: string; displayName?: string },
  ): Promise<void> {
    const newKey = `${selected.providerId}/${selected.modelId}`;
    await product!.setModel(id, {
      providerId: selected.providerId,
      modelId: selected.modelId,
    });
    currentModel = newKey;
    void refreshContextUsage();
    updateFooter();
    notice(
      `switched model to ${currentModel} (${selected.displayName ?? selected.modelId})`,
    );
  }

  function insertBeforeFooter(component: unknown): void {
    insertChatComponent(component as { render(width: number): string[] });
  }

  function ensureSession(): string {
    if (!sessionId && product) {
      sessionId = product.lastThebeSessionId();
    }
    if (!sessionId) {
      throw new Error("no active session; use /new");
    }
    return sessionId;
  }

  function getActiveSelectListTheme(): SelectListTheme {
    return getTuiTheme(currentTheme).selectList;
  }

  function makeMarkdown(text: string): Markdown {
    return makeReplyMarkdown(text, getTuiTheme(currentTheme).markdown);
  }

  async function applyTheme(name: ThemeName, persist = true): Promise<void> {
    currentTheme = name;
    try {
      initTheme(name, false);
    } catch {}
    const pack = getTuiTheme(name);
    (editor as unknown as { theme: unknown }).theme = pack.editor;
    updateEditorBorderColor();
    for (const child of children) {
      child.invalidate?.();
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!(child instanceof Markdown)) continue;
      const source = readMarkdownSource(child);
      const replacement = makeMarkdown(source);
      children[i] = replacement;
      if (replyMarkdown === child) {
        replyMarkdown = replacement;
      }
    }
    if (persist) {
      await saveThebeConfig({ theme: name });
    }
    tui.requestRender();
  }

  function clearMessagesView(): void {
    const keep = new Set([children[0], footerText, editor]);
    for (let i = children.length - 1; i >= 0; i--) {
      if (!keep.has(children[i])) {
        children.splice(i, 1);
      }
    }
    toolComponents.clear();
    tui.requestRender();
  }

  async function loadAndDisplaySessionHistory(thebeId: string): Promise<void> {
    if (!product) return;
    clearMessagesView();
    try {
      const msgs = await product.loadMessages(thebeId);
      for (const m of msgs) {
        if (m.role === "user" && m.text) {
          insertBeforeFooter(makeMarkdown(m.text));
        } else if (m.role === "assistant" && m.text) {
          insertBeforeFooter(makeMarkdown(m.text));
        } else if (m.role === "tool") {
          const component = createToolComponent(
            tui,
            m.toolName ?? "unknown",
            m.toolCallId ?? m.id,
            undefined,
            toolsExpanded,
          );
          component.setArgsComplete();
          component.updateResult(
            toolResultPayload(m.text, Boolean(m.isError)),
          );
          toolComponents.set(m.toolCallId ?? m.id, component);
          insertBeforeFooter(component);
        }
      }
      tui.requestRender();
    } catch {}
  }

  async function runCustomProviderWizard(
    initialProviderId?: string,
  ): Promise<{ providerId: string; modelId: string } | null> {
    if (!product) return null;
    return runCustomProviderWizardFlow(
      { tui, editor, product, notice, getActiveSelectListTheme },
      initialProviderId,
    );
  }

  async function afterProviderLoggedIn(
    providerId: string,
    actionLabel: string,
    preferredModelId?: string,
  ): Promise<void> {
    if (!product || !sessionId) {
      notice(actionLabel);
      return;
    }
    const scoped = await product.listAvailableModels({ providerId });
    if (scoped.length === 0) {
      notice(
        `${actionLabel}. no models available for ${providerId}; use /model after models appear`,
      );
      return;
    }
    const targetModel =
      (preferredModelId
        ? scoped.find((m) => m.modelId === preferredModelId)
        : undefined) ?? scoped[0]!;
    await applyModel(sessionId, targetModel);
    notice(
      `${actionLabel}. selected ${targetModel.providerId}/${targetModel.modelId}`,
    );
  }

  async function resolvePermissionInteractively(
    permissionId: string,
    toolName: string,
  ): Promise<void> {
    if (!product) return;
    const selected = await attachSelectList(
      tui,
      [
        { label: `Allow ${toolName}`, value: "allow" },
        { label: `Deny ${toolName}`, value: "deny" },
      ],
      editor,
      undefined,
      getActiveSelectListTheme(),
    );
    const id = sessionId ?? product.lastThebeSessionId();
    if (!selected || !id) {
      if (!selected) {
        notice(`permission ${permissionId} not resolved — /allow or /deny`);
      }
      return;
    }
    await product.resolvePermission(id, permissionId, {
      response: selected.value as "allow" | "deny",
    });
    if (pendingPermissionId === permissionId) {
      pendingPermissionId = undefined;
    }
    notice(
      `permission ${permissionId} ${selected.value === "allow" ? "allowed" : "denied"}`,
    );
  }

  function insertTool(component: ToolExecutionComponent): void {
    const before = working ?? editor;
    const index = children.indexOf(before as never);
    const insertAt = index >= 0 ? index : Math.max(0, children.length - 1);
    children.splice(insertAt, 0, component as never);
    tui.requestRender();
  }

  function setToolsExpanded(expanded: boolean): void {
    toolsExpanded = expanded;
    for (const child of children) {
      if (child instanceof ToolExecutionComponent) {
        child.setExpanded(expanded);
      }
    }
    tui.requestRender();
  }

  function setHideThinking(hidden: boolean): void {
    hideThinking = hidden;
    if (thinkingBlock) {
      thinkingBlock.setHidden(hidden);
    }
    for (const child of children) {
      if (child instanceof ThinkingBlock) {
        child.setHidden(hidden);
      }
    }
    void saveThebeConfig({ hideThinking: hidden });
    tui.requestRender();
  }

  function beginStream(): void {
    thinkingBlock = new ThinkingBlock(hideThinking);
    insertBeforeFooter(thinkingBlock);
    replyMarkdown = makeMarkdown("");
    insertBeforeFooter(replyMarkdown);
    working = new ElapsedWorking(tui);
    insertBeforeFooter(working);
    updateFooter();
  }

  function endStream(): void {
    if (working) {
      tui.removeChild(working);
      working.stop();
      working = undefined;
    }
    if (thinkingBlock?.isEmpty()) {
      const index = children.indexOf(thinkingBlock as never);
      if (index >= 0) {
        children.splice(index, 1);
      }
    }
    thinkingBlock = undefined;
    streamUnsub?.();
    streamUnsub = undefined;
    replyMarkdown = undefined;
    activeToolName = undefined;
    updateFooter();
  }

  function onEvent(event: NormalizedEvent): void {
    if (event.type === "text_delta" && replyMarkdown) {
      const next = `${readMarkdownSource(replyMarkdown)}${event.text}`;
      replyMarkdown.setText(next);
      stashMarkdownSource(replyMarkdown, next);
      tui.requestRender();
    } else if (event.type === "thinking_delta" && thinkingBlock) {
      thinkingBlock.append(event.text);
      tui.requestRender();
    } else if (event.type === "tool_start") {
      activeToolName = event.toolName;
      working?.setLabel(event.toolName);
      let component = toolComponents.get(event.toolCallId);
      if (!component) {
        component = createToolComponent(
          tui,
          event.toolName,
          event.toolCallId,
          event.args,
          toolsExpanded,
        );
        toolComponents.set(event.toolCallId, component);
        insertTool(component);
      } else if (event.args) {
        component.updateArgs(event.args);
      }
      updateFooter();
    } else if (event.type === "tool_update") {
      const component = toolComponents.get(event.toolCallId);
      if (component) {
        if (event.args) {
          component.updateArgs(event.args);
        }
        if (event.text) {
          component.updateResult(toolResultPayload(event.text, false), true);
        }
      }
    } else if (event.type === "tool_end") {
      activeToolName = undefined;
      working?.setLabel("Working");
      const component = toolComponents.get(event.toolCallId);
      if (component) {
        if (event.args) {
          component.updateArgs(event.args);
        }
        component.setArgsComplete();
        component.updateResult(
          toolResultPayload(event.text, event.isError, event.details),
        );
      }
      updateFooter();
    } else if (event.type === "permission_requested") {
      pendingPermissionId = event.permissionId;
      updateFooter();
      notice(
        `permission requested: ${event.toolName} (${event.risk ?? "standard"}) ${event.argsSummary ?? ""}`,
      );
      void resolvePermissionInteractively(event.permissionId, event.toolName);
    } else if (event.type === "interrupted") {
      notice("session interrupted");
    } else if (event.type === "error") {
      notice(`error: ${event.message}`);
    } else if (event.type === "queue_update") {
      notice(`queued: steering=${event.steering} followUp=${event.followUp}`);
    } else if (event.type === "compaction_start") {
      const reason = event.reason ?? "threshold";
      notice(
        reason === "manual"
          ? "compacting context..."
          : `auto-compacting context (${reason})...`,
      );
    } else if (event.type === "compaction_end") {
      if (event.aborted) {
        notice("compaction aborted");
      } else if (event.errorMessage) {
        notice(`compaction failed: ${event.errorMessage}`);
      } else {
        const before = event.tokensBefore;
        const after = event.estimatedTokensAfter;
        notice(
          before != null
            ? `context compacted (${before.toLocaleString()} → ${after != null ? after.toLocaleString() : "?"} tokens)`
            : "context compacted",
        );
        void refreshContextUsage();
      }
    }
  }

  async function refreshContextUsage(): Promise<void> {
    if (!product || !sessionId) return;
    try {
      const usage = await product.getContextUsage(sessionId);
      const u = usage.contextUsage;
      contextTokensUsed = u.usedTokens;
      contextWindowTotal = u.maxTokens;
      updateFooter();
    } catch {
      // ignore
    }
  }

  async function runPrompt(
    text: string,
    mode: "prompt" | "steer" | "followUp" = "prompt",
  ): Promise<void> {
    if (!product) {
      if (!options.send) {
        throw new Error("TUI requires product or send");
      }
      isResponding = true;
      updateEditorBorderColor();
      editor.disableSubmit = true;
      insertBeforeFooter(makeMarkdown(text));
      beginStream();
      try {
        const reply = await options.send(text);
        if (replyMarkdown) {
          const index = children.indexOf(replyMarkdown);
          if (index >= 0) {
            children[index] = makeMarkdown(reply);
          }
        }
      } finally {
        endStream();
        isResponding = false;
        editor.disableSubmit = false;
        updateFooter();
        updateEditorBorderColor();
        tui.requestRender();
      }
      return;
    }

    const id = ensureSession();
    if (mode === "prompt") {
      if (isResponding) {
        await product.prompt(text, { thebeSessionId: id, mode: "steer" });
        notice(`steered: ${text}`);
        return;
      }
      isResponding = true;
      updateEditorBorderColor();
      insertBeforeFooter(makeMarkdown(text));
      beginStream();
      streamUnsub = product.subscribeLog(id, onEvent);
      try {
        const result = await product.prompt(text, {
          thebeSessionId: id,
          mode: "prompt",
        });
        if (replyMarkdown && !readMarkdownSource(replyMarkdown)) {
          const index = children.indexOf(replyMarkdown);
          if (index >= 0) {
            children[index] = makeMarkdown(result.text);
          }
        }
      } catch (error) {
        notice(error instanceof Error ? error.message : String(error));
      } finally {
        endStream();
        isResponding = false;
        void refreshContextUsage();
        updateFooter();
        updateEditorBorderColor();
        tui.requestRender();
      }
      return;
    }

    await product.prompt(text, { thebeSessionId: id, mode });
    notice(`${mode}: ${text}`);
  }

  const host: SlashHost = {
    tui,
    editor,
    options,
    get product() {
      return product;
    },
    get sessionId() {
      return sessionId;
    },
    set sessionId(value) {
      sessionId = value;
    },
    get sessionTitle() {
      return sessionTitle;
    },
    set sessionTitle(value) {
      sessionTitle = value;
    },
    get currentModel() {
      return currentModel;
    },
    set currentModel(value) {
      currentModel = value;
    },
    get currentThinking() {
      return currentThinking;
    },
    set currentThinking(value) {
      currentThinking = value;
    },
    get currentTheme() {
      return currentTheme;
    },
    set currentTheme(value) {
      currentTheme = value;
    },
    get contextTokensUsed() {
      return contextTokensUsed;
    },
    get contextWindowTotal() {
      return contextWindowTotal;
    },
    get pendingPermissionId() {
      return pendingPermissionId;
    },
    set pendingPermissionId(value) {
      pendingPermissionId = value;
    },
    children,
    footerText,
    notice,
    ensureSession,
    loadAndDisplaySessionHistory,
    clearMessagesView,
    refreshContextUsage,
    updateFooter,
    updateEditorBorderColor,
    setHideThinking,
    applyTheme,
    applyModel,
    insertBeforeFooter,
    makeMarkdown,
    getActiveSelectListTheme,
    runCustomProviderWizard,
    afterProviderLoggedIn,
  };

  async function handleSlash(raw: string): Promise<boolean> {
    return dispatchSlash(host, raw);
  }

  editor.onSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === "/clear") {
      clearMessagesView();
      return;
    }
    if (trimmed.startsWith("!")) {
      const isExcluded = trimmed.startsWith("!!");
      const command = isExcluded ? trimmed.slice(2).trim() : trimmed.slice(1).trim();
      editor.setText("");
      isBashMode = false;
      updateEditorBorderColor();
      if (!command) {
        return;
      }
      if (isExecutingBash) {
        notice("A bash command is already running. Press Esc to cancel it first.");
        return;
      }
      void runBash(command, isExcluded);
      return;
    }
    void (async () => {
      try {
        if (await handleSlash(trimmed)) {
          return;
        }
        await runPrompt(trimmed, "prompt");
      } catch (error) {
        notice(error instanceof Error ? error.message : String(error));
        isResponding = false;
        editor.disableSubmit = false;
        endStream();
      } finally {
        tui.setFocus(editor);
        tui.requestRender();
      }
    })();
  };

  const thinkingCycle: ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  const originalHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    if (matchesKey(data, "ctrl+p")) {
      void handleSlash("/model");
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      const idx = thinkingCycle.indexOf(currentThinking);
      const next =
        thinkingCycle[(idx < 0 ? 0 : idx + 1) % thinkingCycle.length]!;
      currentThinking = next;
      if (product && sessionId) {
        void product.setThinkingLevel(sessionId, next).catch(() => {});
      }
      updateFooter();
      updateEditorBorderColor();
      return;
    }
    if (matchesKey(data, "ctrl+t")) {
      setHideThinking(!hideThinking);
      return;
    }
    if (matchesKey(data, "ctrl+o")) {
      setToolsExpanded(!toolsExpanded);
      return;
    }
    if (matchesKey(data, "escape")) {
      if (currentBashAbortController) {
        currentBashAbortController.abort();
        return;
      }
      if (isBashMode) {
        editor.setText("");
        isBashMode = false;
        updateEditorBorderColor();
        return;
      }
    }
    if (isResponding && matchesKey(data, "alt+enter")) {
      const trimmed = editor.getText().trim();
      if (trimmed && product && sessionId) {
        void product
          .prompt(trimmed, { thebeSessionId: sessionId, mode: "followUp" })
          .then(() => {
            notice(`queued follow-up: ${trimmed}`);
            editor.setText("");
          })
          .catch((error: unknown) =>
            notice(error instanceof Error ? error.message : String(error)),
          );
        return;
      }
    }
    originalHandleInput(data);
  };

  void refreshContextUsage();
  updateFooter();
  if (sessionId && product) {
    void loadAndDisplaySessionHistory(sessionId);
  }
  return {
    editor,
    updateFooter,
    handleSlash,
    isResponding: () => isResponding,
    isExecutingBash: () => isExecutingBash,
    abortBash: () => {
      currentBashAbortController?.abort();
    },
  };
}

export function startThebeTui(options: ThebeTuiOptions): TUI {
  let mode: TuiMode = options.tuiMode ?? "regular";
  const terminal = new ProcessTerminal();
  let tui: TUI | undefined;

  const launch = (): TUI => {
    tui = mode === "fullscreen"
      ? new TuiAltScreen(terminal, true)
      : new TuiMainScreen(terminal);
    tui.setClearOnShrink(true);
    const chat = attachThebeChat(tui, {
      ...options,
      tuiMode: mode,
      onTuiModeChange: async (next) => {
        if (next === mode) return;
        mode = next;
        options.tuiMode = next;
        tui?.stop();
        const nextTui = launch();
        nextTui.start();
      },
    });
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        tui?.stop();
        process.exit(0);
      }
      if (matchesKey(data, "escape")) {
        if (chat.isExecutingBash()) {
          chat.abortBash();
          return { consume: true };
        }
        if (chat.isResponding() && options.product) {
          const id = options.sessionId ?? options.product.lastThebeSessionId();
          if (id) {
            void options.product.interrupt(id).catch(() => {});
          }
          return { consume: true };
        }
        return undefined;
      }
      return undefined;
    });
    return tui;
  };

  const started = launch();
  started.start();
  return started;
}
