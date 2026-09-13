import type { NormalizedEvent, RuntimeMessage, ThebeAgent } from "../../../agent/index.ts";
import {
  Markdown,
  type Component,
  type SelectListTheme,
  type TUI,
} from "../rendering/adapter.ts";
import {
  attachModalSelectList,
  attachSelectList,
  dismissOverlay,
} from "../overlays/index.ts";
import { FooterDock } from "../display/footer.ts";
import { readMarkdownSource, stashMarkdownSource } from "../display/markdown-source.ts";
import {
  ElapsedWorking,
  ThinkingBlock,
  createToolComponent,
  makeReplyMarkdown,
  toolResultPayload,
} from "./transcript.ts";
import { ChatState } from "./state.ts";

export type EventPresenterDeps = {
  tui: TUI;
  agent?: ThebeAgent;
  state: ChatState;
  editor: Component;
  startScreen: Component;
  footerText: FooterDock;
  workspacePath: string;
  notice: (text: string) => void;
  updateFooter: () => void;
  updateEditorBorderColor: () => void;
  refreshContextUsage: () => Promise<void>;
  getActiveSelectListTheme: () => SelectListTheme;
  getSessionId: () => string | undefined;
  makeMarkdown: (text: string) => Markdown;
  onPermissionResolved?: () => void;
  persistHideThinking?: (hidden: boolean) => void;
};

/** Owns the mapping from Agent events and messages to transcript widgets. */
export class EventPresenter {
  private readonly deps: EventPresenterDeps;

  constructor(deps: EventPresenterDeps) {
    this.deps = deps;
  }

  insertBeforeFooter(component: Component | { render(width: number): string[] }): void {
    const { tui, editor } = this.deps;
    const index = tui.children.indexOf(editor);
    const insertAt = index >= 0 ? index : Math.max(0, tui.children.length - 1);
    tui.children.splice(insertAt, 0, component as Component);
    tui.requestRender();
  }

  insertBeforeWorking(component: Component): void {
    const { tui, editor, state } = this.deps;
    const before = state.working ?? editor;
    const index = tui.children.indexOf(before);
    const insertAt = index >= 0 ? index : Math.max(0, tui.children.length - 1);
    tui.children.splice(insertAt, 0, component);
    tui.requestRender();
  }

  beginStream(): void {
    const { state } = this.deps;
    state.thinkingBlock = new ThinkingBlock(state.hideThinking);
    this.insertBeforeFooter(state.thinkingBlock);
    state.replyMarkdown = this.deps.makeMarkdown("");
    this.insertBeforeFooter(state.replyMarkdown);
    state.working = new ElapsedWorking(this.deps.tui);
    this.insertBeforeFooter(state.working);
    this.deps.updateFooter();
  }

  endStream(): void {
    const { state, tui } = this.deps;
    if (state.working) {
      tui.removeChild(state.working);
      state.working.stop();
      state.working = undefined;
    }
    if (state.thinkingBlock) {
      state.thinkingBlock.finish();
      if (state.thinkingBlock.isEmpty()) {
        const index = tui.children.indexOf(state.thinkingBlock);
        if (index >= 0) tui.children.splice(index, 1);
      }
    }
    state.thinkingBlock = undefined;
    if (state.replyMarkdown && !readMarkdownSource(state.replyMarkdown).trim()) {
      const index = tui.children.indexOf(state.replyMarkdown);
      if (index >= 0) tui.children.splice(index, 1);
    }
    state.streamUnsub?.();
    state.streamUnsub = undefined;
    state.replyMarkdown = undefined;
    state.activeToolName = undefined;
    this.deps.updateFooter();
  }

  clearMessagesView(): void {
    const { state, tui, startScreen, footerText, editor } = this.deps;
    state.historyLoadGeneration += 1;
    state.streamUnsub?.();
    state.streamUnsub = undefined;
    state.currentBashAbortController?.abort();
    const keep = new Set<Component>([startScreen, footerText, editor]);
    for (const child of [...tui.children]) {
      if (keep.has(child)) continue;
      dismissOverlay(child);
      if (tui.children.includes(child)) tui.removeChild(child);
    }
    state.working?.stop();
    state.working = undefined;
    state.thinkingBlock = undefined;
    state.replyMarkdown = undefined;
    state.activeToolName = undefined;
    state.toolComponents.clear();
    footerText.setSummary(undefined);
    tui.requestRender();
  }

  displayHistory(messages: RuntimeMessage[]): void {
    for (const message of messages) {
      if (message.role === "user" && message.text) {
        this.insertBeforeFooter(this.deps.makeMarkdown(message.text));
      } else if (message.role === "assistant") {
        if (message.thinking) {
          const block = new ThinkingBlock(this.deps.state.hideThinking);
          block.append(message.thinking);
          block.finish();
          this.insertBeforeFooter(block);
        }
        if (message.text) this.insertBeforeFooter(this.deps.makeMarkdown(message.text));
      } else if (message.role === "tool") {
        const id = message.toolCallId ?? message.id;
        const component = createToolComponent(
          this.deps.tui,
          message.toolName ?? "unknown",
          id,
          message.args,
          this.deps.state.toolsExpanded,
          this.deps.workspacePath,
        );
        component.setArgsComplete();
        component.updateResult(toolResultPayload(message.text, Boolean(message.isError), message.details));
        this.deps.state.toolComponents.set(id, component);
        this.insertBeforeFooter(component);
      }
    }
  }

  setToolsExpanded(expanded: boolean): void {
    this.deps.state.toolsExpanded = expanded;
    for (const component of this.deps.state.toolComponents.values()) component.setExpanded(expanded);
    this.deps.tui.requestRender();
  }

  setHideThinking(hidden: boolean): void {
    this.deps.state.hideThinking = hidden;
    if (this.deps.state.thinkingBlock) this.deps.state.thinkingBlock.setHidden(hidden);
    for (const child of this.deps.tui.children) {
      if (child instanceof ThinkingBlock) child.setHidden(hidden);
    }
    this.deps.persistHideThinking?.(hidden);
    this.deps.tui.requestRender();
  }

  onEvent(event: NormalizedEvent): void {
    const { state, tui } = this.deps;
    if (state.disposed) return;
    switch (event.type) {
      case "thinking_level_changed":
        state.currentThinking = event.level;
        state.thinkingInfo = { ...state.thinkingInfo, level: event.level };
        this.deps.updateFooter();
        this.deps.updateEditorBorderColor();
        break;
      case "text_delta": {
        if (state.thinkingBlock && !state.thinkingBlock.isFinished()) {
          state.thinkingBlock.finish();
          state.working?.setLabel("Working");
        }
        if (!state.replyMarkdown) {
          state.replyMarkdown = this.deps.makeMarkdown("");
          this.insertBeforeWorking(state.replyMarkdown);
        }
        const next = `${readMarkdownSource(state.replyMarkdown)}${event.text}`;
        state.replyMarkdown.setText(next);
        stashMarkdownSource(state.replyMarkdown, next);
        tui.requestRender();
        break;
      }
      case "thinking_delta":
        if (state.thinkingBlock) {
          state.thinkingBlock.append(event.text);
          state.working?.setLabel("Thinking");
          tui.requestRender();
        }
        break;
      case "tool_start": {
        if (state.thinkingBlock && !state.thinkingBlock.isFinished()) state.thinkingBlock.finish();
        state.activeToolName = event.toolName;
        state.working?.setLabel(event.toolName);
        let component = state.toolComponents.get(event.toolCallId);
        if (!component) {
          component = createToolComponent(tui, event.toolName, event.toolCallId, event.args, state.toolsExpanded, this.deps.workspacePath);
          state.toolComponents.set(event.toolCallId, component);
          this.insertBeforeWorking(component);
        } else if (event.args) component.updateArgs(event.args);
        if (state.replyMarkdown && !readMarkdownSource(state.replyMarkdown).trim()) {
          const index = tui.children.indexOf(state.replyMarkdown);
          if (index >= 0) tui.children.splice(index, 1);
        }
        state.replyMarkdown = undefined;
        this.deps.updateFooter();
        break;
      }
      case "tool_update": {
        const component = state.toolComponents.get(event.toolCallId);
        if (component) {
          if (event.args) component.updateArgs(event.args);
          if (event.text) component.updateResult(toolResultPayload(event.text, false), true);
        }
        break;
      }
      case "tool_end": {
        state.activeToolName = undefined;
        state.working?.setLabel("Working");
        const component = state.toolComponents.get(event.toolCallId);
        if (component) {
          if (event.args) component.updateArgs(event.args);
          component.setArgsComplete();
          component.updateResult(toolResultPayload(event.text, event.isError, event.details));
        }
        state.replyMarkdown = undefined;
        this.deps.updateFooter();
        break;
      }
      case "permission_requested":
        state.pendingPermissionId = event.permissionId;
        this.deps.updateFooter();
        void this.resolvePermissionInteractively(event.permissionId, event.toolName, event.risk);
        break;
      case "interrupted": this.deps.notice("session interrupted"); break;
      case "error": this.deps.notice(`error: ${event.message}`); break;
      case "queue_update": this.deps.notice(`queued: steering=${event.steering} followUp=${event.followUp}`); break;
      case "compaction_start": {
        const reason = event.reason ?? "threshold";
        this.deps.notice(reason === "manual" ? "compacting context..." : `auto-compacting context (${reason})...`);
        break;
      }
      case "compaction_end":
        if (event.aborted) this.deps.notice("compaction aborted");
        else if (event.errorMessage) this.deps.notice(`compaction failed: ${event.errorMessage}`);
        else {
          const before = event.tokensBefore;
          const after = event.estimatedTokensAfter;
          this.deps.notice(before != null ? `context compacted (${before.toLocaleString()} → ${after != null ? after.toLocaleString() : "?"} tokens)` : "context compacted");
          void this.deps.refreshContextUsage();
        }
        break;
      case "summary_ready":
        this.deps.footerText.setSummary(event.summary);
        tui.requestRender();
        break;
      default:
        break;
    }
  }

  private async resolvePermissionInteractively(
    permissionId: string,
    toolName: string,
    risk?: "high" | "standard",
  ): Promise<void> {
    const { agent, state, tui, editor } = this.deps;
    if (!agent) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!agent.pendingPermissionIds().includes(permissionId)) {
      if (state.pendingPermissionId === permissionId) {
        state.pendingPermissionId = undefined;
        this.deps.updateFooter();
      }
      return;
    }
    const picker = tui.hasOverlay() ? attachModalSelectList : attachSelectList;
    const selected = await picker(
      tui,
      [
        { label: `Deny ${toolName}${risk === "high" ? " (high risk)" : ""}`, value: "deny" },
        { label: `Allow ${toolName} once`, value: "allow" },
        { label: `Always allow ${toolName} for this session${risk === "high" ? " (high risk)" : ""}`, value: "remember-tool" },
        { label: `Allow this exact ${toolName} request only`, value: "remember-request" },
        { label: "Allow this conversation", value: "remember-conversation" },
      ],
      tui.hasOverlay() ? undefined : editor,
      undefined,
      this.deps.getActiveSelectListTheme(),
    );
    const id = this.deps.getSessionId() ?? agent.lastThebeSessionId();
    if (!selected || !id) {
      if (!selected) this.deps.notice(`permission ${permissionId} not resolved — /allow or /deny`);
      return;
    }
    await agent.resolvePermission(id, permissionId, {
      response: selected.value === "deny" ? "deny" : "allow",
      remember: selected.value !== "allow" && selected.value !== "deny",
      rememberScope: selected.value === "remember-tool" ? "tool" : selected.value === "remember-conversation" ? "conversation" : "request",
    });
    if (state.pendingPermissionId === permissionId) state.pendingPermissionId = undefined;
    this.deps.onPermissionResolved?.();
    this.deps.updateFooter();
    if (selected.value === "deny") this.deps.notice(`permission ${toolName} denied`);
  }
}
