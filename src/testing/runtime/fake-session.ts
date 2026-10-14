import { randomUUID } from "node:crypto";
import {
  asPromptInput,
  type BackgroundTask,
  type NormalizedEvent,
  type PromptInput,
  type RuntimeExport,
  type RuntimeMessage,
  type RuntimeModel,
  type RuntimeSession,
  type RuntimeThinkingInfo,
  type ThebeSessionContext,
  type ThinkingLevel,
} from "../../agent/runtime/interface.ts";
import { permissionRisk, summarizeArgs } from "../../agent/security/redaction.ts";
import {
  isInlineTextAttachment,
  renderInlineTextFile,
  renderLinesSnippet,
} from "../../agent/runtime/prompt-files.ts";
import { isInlineTextFile } from "../../agent/runtime/interface.ts";
import type { FakeQueuedTurn, FakeSessionState } from "./fixtures.ts";
import { httpError } from "../../agent/types.ts";

export type FakeInboundToolResult = {
  toolName: string;
  text: string;
  isError: boolean;
};

export type FakeSessionControls = {
  models: RuntimeModel[];
  queue: FakeQueuedTurn[];
  inboundToolResults: FakeInboundToolResult[];
  recordCompact(customInstructions?: string): void;
};

export function createFakeSession(
  state: FakeSessionState,
  controls: FakeSessionControls,
): RuntimeSession {
  const listeners = new Set<(event: NormalizedEvent) => void>();
  let aborted = false;
  let busy = false;
  const steering: string[] = [];
  const followUps: string[] = [];

  const emit = (event: NormalizedEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  function getThinkingInfo(): RuntimeThinkingInfo {
    const model = controls.models.find(
      (candidate) =>
        candidate.providerId === state.model.providerId &&
        candidate.modelId === state.model.modelId,
    );
    const supportsThinking = model?.supportsThinking ?? false;
    const availableLevels: ThinkingLevel[] = supportsThinking
      ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
      : ["off"];
    return {
      level: availableLevels.includes(state.thinkingLevel)
        ? state.thinkingLevel
        : "off",
      availableLevels,
      supportsThinking,
    };
  }

  async function runQueued(): Promise<void> {
    const turn = controls.queue.shift();
    if (!turn && state.probeReply) {
      emit({ type: "text_delta", text: state.probeReply });
      state.messages.push({
        id: randomUUID(),
        role: "assistant",
        text: state.probeReply,
      });
      emit({ type: "turn_end" });
      emit({ type: "session_end", text: state.probeReply });
      return;
    }
    if (!turn || turn.kind === "hang") {
      await new Promise<void>((_resolve, reject) => {
        if (aborted) {
          reject(new Error("aborted"));
          return;
        }
        state.abortWaiters.push(() => {
          reject(new Error("aborted"));
        });
      });
      return;
    }
    if (turn.kind === "error") {
      emit({ type: "error", message: turn.message });
      throw new Error(turn.message);
    }
    if (turn.kind === "text") {
      if (turn.thinking) {
        emit({ type: "thinking_delta", text: turn.thinking });
      }
      emit({ type: "text_delta", text: turn.text });
      state.messages.push({
        id: randomUUID(),
        role: "assistant",
        text: turn.text,
      });
      emit({ type: "turn_end" });
      emit({ type: "session_end", text: turn.text });
      return;
    }
    for (const call of turn.calls) {
      if (aborted) {
        break;
      }
      const toolCallId = call.id ?? randomUUID();
      emit({
        type: "tool_start",
        toolName: call.name,
        toolCallId,
        args: call.args
          ? JSON.parse(summarizeArgs(call.args, 8_000))
          : undefined,
      });
      const needsApproval = state.toolsRequiringApproval.includes(call.name);
      if (needsApproval && state.permissionHandler) {
        const permissionId = randomUUID();
        const request = {
          permissionId,
          toolName: call.name,
          toolCallId,
          args: call.args,
          argsSummary: summarizeArgs(call.args),
          risk: permissionRisk(call.name),
        };
        const preflight =
          (await state.permissionHandler.preflight?.(request)) ?? "ask";
        const decision =
          preflight === "allow"
            ? "allow"
            : preflight === "deny"
              ? "deny"
              : await (async () => {
                  emit({
                    type: "permission_requested",
                    permissionId,
                    toolName: call.name,
                    toolCallId,
                    argsSummary: summarizeArgs(call.args),
                    risk: permissionRisk(call.name),
                  });
                  return state.permissionHandler!.request(request);
                })();
        if (decision !== "allow") {
          const text = "denied by user";
          emit({
            type: "tool_end",
            toolName: call.name,
            toolCallId,
            isError: true,
            text,
          });
          state.messages.push({
            id: randomUUID(),
            role: "tool",
            text,
            toolName: call.name,
            toolCallId,
            isError: true,
          });
          continue;
        }
      }
      const tool = state.tools.find((item) => item.name === call.name);
      let text = "";
      let isError = false;
      if (!tool) {
        isError = true;
        text = `unknown tool: ${call.name}`;
      } else {
        try {
          const ac = new AbortController();
          state.toolAborts.set(toolCallId, ac);
          const result = await tool.execute(
            toolCallId,
            call.args ?? {},
            ac.signal,
          );
          text = result.content.map((block) => block.text).join("\n");
          isError = Boolean(result.isError);
        } catch (error) {
          isError = true;
          text = error instanceof Error ? error.message : String(error);
        } finally {
          state.toolAborts.delete(toolCallId);
        }
      }
      controls.inboundToolResults.push({
        toolName: call.name,
        text,
        isError,
      });
      emit({
        type: "tool_end",
        toolName: call.name,
        toolCallId,
        isError,
        text,
      });
      state.messages.push({
        id: randomUUID(),
        role: "tool",
        text,
        toolName: call.name,
        toolCallId,
        isError,
      });
    }
    emit({ type: "turn_end" });
    if (!aborted && controls.queue.length > 0) {
      await runQueued();
      return;
    }
    const last = lastAssistant(state.messages);
    emit({ type: "session_end", text: last });
  }

  async function runPrompt(input: string | PromptInput): Promise<void> {
    aborted = false;
    busy = true;
    state.reverted = undefined;
    const prompt = asPromptInput(input);
    const inlined = (prompt.files ?? [])
      .filter(isInlineTextAttachment)
      .map(renderInlineTextFile)
      .join("\n\n");
    const references = (prompt.files ?? [])
      .filter((file) => file.mode === "reference")
      .map(
        (file) =>
          `[file reference: ${file.path ?? file.filename ?? "attachment"} (${file.mediaType})]`,
      )
      .join("\n");
    const lines = (prompt.files ?? [])
      .filter((file) => file.mode === "lines")
      .map((file) => renderLinesSnippet(file))
      .join("\n");
    const otherFiles = (prompt.files ?? [])
      .filter(
        (file) =>
          (!file.mode || file.mode === "inline") &&
          !isInlineTextFile(file.mediaType),
      )
      .map(
        (file) =>
          `[file: ${file.filename ?? "attachment"} (${file.mediaType})]`,
      )
      .join("\n");
    const extra = [inlined, references, lines, otherFiles]
      .filter((part) => part.length > 0)
      .join("\n");
    const text = extra ? `${prompt.text}\n${extra}` : prompt.text;
    state.messages.push({ id: randomUUID(), role: "user", text });
    try {
      await runQueued();
    } finally {
      busy = false;
    }
  }

  return {
    runtimeSessionId: state.id,
    prompt: runPrompt,
    async steer(text: string): Promise<void> {
      if (!busy) {
        await runPrompt(text);
        return;
      }
      steering.push(text);
      emit({
        type: "queue_update",
        steering: steering.length,
        followUp: followUps.length,
      });
    },
    async followUp(text: string): Promise<void> {
      if (!busy) {
        await runPrompt(text);
        return;
      }
      followUps.push(text);
      emit({
        type: "queue_update",
        steering: steering.length,
        followUp: followUps.length,
      });
    },
    async abort(): Promise<void> {
      aborted = true;
      for (const controller of state.toolAborts.values()) {
        controller.abort();
      }
      emit({ type: "interrupted" });
      const waiters = state.abortWaiters.splice(0);
      for (const waiter of waiters) {
        waiter();
      }
    },
    subscribe(listener: (event: NormalizedEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lastAssistantText(): string {
      return lastAssistant(state.messages);
    },
    toolNames(): string[] {
      return [...state.builtinTools, ...state.tools.map((tool) => tool.name)];
    },
    async compact(customInstructions?: string): Promise<void> {
      controls.recordCompact(customInstructions);
      state.lastCompactInstructions = customInstructions;
      emit({ type: "compaction_start", reason: "manual" });
      state.compacted = true;
      state.compactedAt = new Date().toISOString();
      state.messages = [
        { id: randomUUID(), role: "assistant", text: "[compacted]" },
        ...state.messages.slice(-2),
      ];
      emit({
        type: "compaction_end",
        aborted: false,
        reason: "manual",
        tokensBefore: 8_000,
        estimatedTokensAfter: 2_000,
      });
    },
    setAutoCompactionEnabled(enabled: boolean): void {
      state.autoCompact = enabled;
    },
    autoCompactionEnabled(): boolean {
      return state.autoCompact;
    },
    async exportSession(): Promise<RuntimeExport> {
      const jsonl = state.messages
        .map((message) => JSON.stringify(message))
        .join("\n");
      const rows = state.messages
        .map(
          (message) =>
            `<li><strong>${escapeHtml(message.role)}</strong><pre>${escapeHtml(message.text)}</pre></li>`,
        )
        .join("\n");
      return {
        jsonl,
        html: `<!DOCTYPE html><html><body><ol>${rows}</ol></body></html>`,
      };
    },
    messages(): RuntimeMessage[] {
      return state.messages.slice();
    },
    getThinkingInfo,
    getForkMessages(): Array<{ entryId: string; text: string }> {
      return state.messages
        .filter((message) => message.role === "user" && message.text)
        .map((message) => ({ entryId: message.id, text: message.text ?? "" }));
    },
    async reloadResources(): Promise<void> {
      state.resourceReloads += 1;
    },
    async setModel(model): Promise<void> {
      const known = controls.models.some(
        (row) =>
          row.providerId === model.providerId && row.modelId === model.modelId,
      );
      if (!known) {
        throw httpError(404, `unknown model: ${model.providerId}/${model.modelId}`);
      }
      state.model = model;
    },
    async setThinkingLevel(level: ThinkingLevel): Promise<void> {
      state.thinkingLevel = getThinkingInfo().availableLevels.includes(level)
        ? level
        : "off";
    },
    async stopToolCall(toolCallId: string): Promise<void> {
      const controller = state.toolAborts.get(toolCallId);
      if (!controller) {
        return;
      }
      controller.abort();
      state.toolAborts.delete(toolCallId);
      emit({
        type: "tool_end",
        toolName: "interrupted",
        toolCallId,
        isError: true,
        text: "tool call stopped by user",
      });
    },
    async navigateTo(leafId: string): Promise<void> {
      state.leafId = leafId;
    },
    getLeafId(): string | undefined {
      return state.leafId ?? state.messages.at(-1)?.id;
    },
    async getContextUsage(): Promise<ThebeSessionContext> {
      const totalChars = state.messages.reduce(
        (sum, message) => sum + (message.text?.length ?? 0),
        0,
      );
      const tokens = Math.ceil(totalChars / 4);
      let userMessages = 0;
      let assistantMessages = 0;
      let toolCalls = 0;
      let toolResults = 0;
      for (const message of state.messages) {
        if (message.role === "user") userMessages++;
        else if (message.role === "assistant") assistantMessages++;
        else if (
          message.role === "tool" ||
          (message as { role?: string }).role === "toolResult"
        ) {
          toolResults++;
        }
        if (message.toolName) toolCalls++;
      }
      return {
        contextUsage: { usedTokens: tokens, maxTokens: 128_000 },
        estimatedCost: { amount: 0.001, currency: "USD" },
        compaction: {
          lastCompactedAt: state.compactedAt,
          nearThreshold: state.autoCompact && tokens > 128_000 - 16_384,
          enabled: state.autoCompact,
        },
        sessionStats: {
          sessionFile: "In-memory",
          sessionId: state.id,
          userMessages,
          assistantMessages,
          toolCalls,
          toolResults,
          totalMessages: state.messages.length,
          tokens: {
            input: tokens,
            output: Math.ceil(tokens * 0.3),
            cacheRead: 0,
            cacheWrite: 0,
            total: Math.ceil(tokens * 1.3),
          },
          cost: 0.001,
        },
        sessionName: (state as { title?: string }).title,
      };
    },
    async listBackgroundTasks(): Promise<BackgroundTask[]> {
      return state.backgroundTasks.map((task) => ({ ...task }));
    },
    async stopBackgroundTask(taskId: string): Promise<void> {
      const task = state.backgroundTasks.find((item) => item.id === taskId);
      if (task) {
        task.status = "stopped";
        task.finishedAt ??= new Date().toISOString();
        task.updatedAt ??= task.finishedAt;
      }
    },
    async revert(): Promise<void> {
      if (state.reverted) {
        return;
      }
      const lastUser = [...state.messages]
        .reverse()
        .find((message) => message.role === "user");
      if (!lastUser) {
        throw new Error("nothing to revert");
      }
      const index = state.messages.findIndex(
        (message) => message.id === lastUser.id,
      );
      state.reverted = state.messages.slice(index);
      state.messages = state.messages.slice(0, index);
    },
    async unrevert(): Promise<void> {
      if (!state.reverted) {
        throw new Error("nothing to unrevert");
      }
      state.messages = [...state.messages, ...state.reverted];
      state.reverted = undefined;
    },
    async executeBash(
      command: string,
      onChunk?: (chunk: string) => void,
    ): Promise<{ exitCode?: number; cancelled: boolean; output: string }> {
      const output = `fake output for ${command}\n`;
      onChunk?.(output);
      return { exitCode: 0, cancelled: false, output };
    },
    dispose(): void {
      listeners.clear();
    },
  };
}

function lastAssistant(messages: RuntimeMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message.text;
    }
  }
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
