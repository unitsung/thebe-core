import type {
  CreateRuntimeSessionOptions,
  NormalizedEvent,
  PromptInput,
  RuntimeModelRef,
  RuntimeSession,
  RuntimeThinkingInfo,
  ThinkingLevel,
  BackgroundTask,
  ThebeSessionContext,
} from "../../../agent/runtime/interface.ts";
import {
  PI_BUILTIN_TOOLS,
  asPromptInput,
  isInlineTextFile,
} from "../../../agent/runtime/interface.ts";
import {
  isInlineTextAttachment,
  renderInlineTextFile,
  renderLinesSnippet,
} from "../../../agent/runtime/prompt-files.ts";
import { mapPiEvent, mapPiMessages } from "./map-events.ts";
import { exportPiSession } from "./pi-export.ts";
import type { PiSession } from "./pi-session.ts";
import { lastAssistantText } from "./pi-tools.ts";
import { DEFAULT_COMPACTION_RESERVE_TOKENS } from "../config/user-config.ts";
import type { PiModelShape } from "../config/model-shape.ts";
import type {
  BackgroundTaskRegistry,
  BashOperations,
} from "./background-tasks.ts";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function isThinkingLevel(value: string): value is RuntimeThinkingInfo["level"] {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function wrapSession(
  session: PiSession,
  create: CreateRuntimeSessionOptions,
  existingListeners: Set<(event: NormalizedEvent) => void> | undefined,
  resolveModelRef: (
    providerId: string,
    modelId: string
  ) => PiModelShape | undefined,
  refreshModels?: () => Promise<void>,
  toolControllers?: Map<string, AbortController>,
  backgroundTasks?: BackgroundTaskRegistry,
  bashOperations?: BashOperations
): RuntimeSession {
  const listeners =
    existingListeners ?? new Set<(event: NormalizedEvent) => void>();
  let revertedLeaf: string | undefined;
  let lastCompactedAt: string | undefined;
  function terminalModelError(): string | undefined {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const message = session.messages[i] as {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
      };
      if (message.role === "assistant") {
        return message.stopReason === "error"
          ? message.errorMessage || "Model request failed"
          : undefined;
      }
      if (message.role === "user") return undefined;
    }
    return undefined;
  }
  session.subscribe((event) => {
    // Pi's agent_end is a turn boundary; automatic retries can follow it.
    // Only agent_settled marks the completed request in the current SDK.
    if ((event as { type?: string }).type === "agent_end") return;
    const mapped = mapPiEvent(event as Parameters<typeof mapPiEvent>[0]);
    if (!mapped) {
      return;
    }
    if (mapped.type === "session_end") {
      if (terminalModelError()) return;
      mapped.text = lastAssistantText(session);
    }
    if (mapped.type === "compaction_end" && !mapped.aborted) {
      lastCompactedAt = new Date().toISOString();
    }
    for (const listener of listeners) {
      listener(mapped);
    }
  });
  function emit(event: NormalizedEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  async function promptInput(input: string | PromptInput): Promise<void> {
    const prompt = asPromptInput(input);
    const images = (prompt.files ?? [])
      .filter(
        (file) =>
          (!file.mode || file.mode === "inline") &&
          file.data &&
          file.mediaType.startsWith("image/")
      )
      .map((file) => ({
        type: "image" as const,
        mimeType: file.mediaType,
        data: file.data!,
      }));
    if (images.length > 0 && !session.model?.input?.includes("image")) {
      throw new Error(
        "The selected model does not support image input. Select a vision model before sending images."
      );
    }
    const inlined = (prompt.files ?? [])
      .filter(isInlineTextAttachment)
      .map(renderInlineTextFile)
      .join("\n\n");
    const references = (prompt.files ?? [])
      .filter((file) => file.mode === "reference")
      .map(
        (file) =>
          `[file reference: ${file.path ?? file.filename ?? "attachment"} (${file.mediaType})]`
      )
      .join("\n");
    const lines = (prompt.files ?? [])
      .filter((file) => file.mode === "lines")
      .map((file) => renderLinesSnippet(file, create.cwd))
      .join("\n");
    const otherFiles = (prompt.files ?? [])
      .filter(
        (file) =>
          (!file.mode || file.mode === "inline") &&
          !file.mediaType.startsWith("image/") &&
          !isInlineTextFile(file.mediaType)
      )
      .map(
        (file) => `[file: ${file.filename ?? "attachment"} (${file.mediaType})]`
      )
      .join("\n");
    const text = [prompt.text, inlined, references, lines, otherFiles]
      .filter((part) => part.length > 0)
      .join("\n");
    await session.prompt(text, images.length > 0 ? { images } : undefined);
    const failure = terminalModelError();
    if (failure) throw new Error(failure);
  }

  return {
    runtimeSessionId: session.sessionId,
    prompt: promptInput,
    steer: (text) => session.steer(text),
    followUp: (text) => session.followUp(text),
    abort: async () => {
      emit({ type: "interrupted" });
      await session.abort();
    },
    async stopToolCall(toolCallId: string): Promise<void> {
      const controller = toolControllers?.get(toolCallId);
      const hadController = Boolean(controller);
      controller?.abort();
      const bash = session as {
        abortBash?: () => void | Promise<void>;
      };
      if (!hadController) {
        await bash.abortBash?.();
      }
      if (hadController || typeof bash.abortBash === "function") {
        emit({
          type: "tool_end",
          toolName: "interrupted",
          toolCallId,
          isError: true,
          text: "tool call stopped by user",
        });
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lastAssistantText: () => lastAssistantText(session),
    toolNames: () =>
      session.getActiveToolNames?.() ?? [
        ...(create.builtinTools ?? PI_BUILTIN_TOOLS),
        ...create.customTools.map((tool) => tool.name),
      ],
    compact: async (customInstructions?: string) => {
      await session.compact(customInstructions);
    },
    exportSession: () => exportPiSession(session as never),
    messages: () => mapPiMessages(session.messages),
    currentModel: () =>
      session.model
        ? { providerId: session.model.provider, modelId: session.model.id }
        : undefined,
    getThinkingInfo(): RuntimeThinkingInfo {
      const available: RuntimeThinkingInfo["availableLevels"] = (
        session.getAvailableThinkingLevels?.() ?? ["off"]
      ).filter(isThinkingLevel);
      const availableLevels: RuntimeThinkingInfo["availableLevels"] = [
        "off",
        ...available.filter((level) => level !== "off"),
      ];
      const rawLevel = session.thinkingLevel;
      const level =
        typeof rawLevel === "string" && isThinkingLevel(rawLevel)
          ? rawLevel
          : "off";
      return {
        level: availableLevels.includes(level) ? level : "off",
        availableLevels,
        supportsThinking:
          session.supportsThinking?.() ?? availableLevels.length > 1,
      };
    },
    async navigateTo(leafId: string): Promise<void> {
      await session.navigateTree(leafId);
    },
    getLeafId(): string | undefined {
      return session.sessionManager.getLeafId() ?? undefined;
    },
    getForkMessages(): Array<{ entryId: string; text: string }> {
      const forking = session as {
        getUserMessagesForForking?: () => Array<{
          entryId: string;
          text: string;
        }>;
      };
      if (typeof forking.getUserMessagesForForking === "function") {
        return forking.getUserMessagesForForking();
      }
      return mapPiMessages(session.messages)
        .filter((m) => m.role === "user" && m.text)
        .map((m) => ({ entryId: m.id, text: m.text ?? "" }));
    },
    async reloadResources(): Promise<void> {
      await session.reload?.();
    },
    async getContextUsage(): Promise<ThebeSessionContext> {
      const raw = (
        session as {
          getContextUsage?: () =>
            | {
                tokens: number | null;
                contextWindow: number;
                percent: number | null;
              }
            | undefined;
        }
      ).getContextUsage?.();
      const fallbackWindow =
        (session as { model?: { contextWindow?: number } }).model
          ?.contextWindow ?? 1_048_576;
      const maxTokens = raw?.contextWindow ?? fallbackWindow;
      let usedTokens = raw?.tokens ?? 0;
      if (usedTokens === null || usedTokens === 0) {
        const msgs = mapPiMessages(session.messages);
        const chars = msgs.reduce((acc, m) => acc + (m.text?.length ?? 0), 0);
        usedTokens = Math.ceil(chars / 4);
      }
      const sessionStats = (
        session as {
          getSessionStats?: () => ThebeSessionContext["sessionStats"];
        }
      ).getSessionStats?.();
      const sessionName = (
        session as {
          sessionManager?: { getSessionName?: () => string | undefined };
        }
      ).sessionManager?.getSessionName?.();
      const costAmount = sessionStats?.cost ?? 0;
      const pathEntries =
        session.sessionManager.getBranch?.() ??
        session.sessionManager.getEntries?.() ??
        [];
      let compactedAt = lastCompactedAt;
      for (let i = pathEntries.length - 1; i >= 0; i--) {
        const entry = pathEntries[i];
        if (
          entry?.type === "compaction" &&
          typeof entry.timestamp === "number"
        ) {
          compactedAt = new Date(entry.timestamp).toISOString();
          break;
        }
      }
      const autoEnabled =
        typeof session.autoCompactionEnabled === "boolean"
          ? session.autoCompactionEnabled
          : true;
      const reserve = DEFAULT_COMPACTION_RESERVE_TOKENS;
      return {
        contextUsage: { usedTokens, maxTokens },
        estimatedCost: { amount: costAmount, currency: "USD" },
        compaction: {
          lastCompactedAt: compactedAt,
          nearThreshold:
            autoEnabled &&
            maxTokens > reserve &&
            usedTokens > maxTokens - reserve,
          enabled: autoEnabled,
        },
        sessionStats,
        sessionName,
      };
    },
    setAutoCompactionEnabled(enabled: boolean): void {
      session.setAutoCompactionEnabled?.(enabled);
    },
    autoCompactionEnabled(): boolean {
      return typeof session.autoCompactionEnabled === "boolean"
        ? session.autoCompactionEnabled
        : true;
    },
    async listBackgroundTasks(): Promise<BackgroundTask[]> {
      if (backgroundTasks) return backgroundTasks.list();
      const native = session as unknown as {
        listBackgroundTasks?: () => Promise<BackgroundTask[]>;
      };
      return native.listBackgroundTasks?.() ?? [];
    },
    async stopBackgroundTask(taskId: string): Promise<void> {
      if (backgroundTasks) {
        await backgroundTasks.stop(taskId);
        return;
      }
      const native = session as unknown as {
        stopBackgroundTask?: (taskId: string) => Promise<void>;
      };
      await native.stopBackgroundTask?.(taskId);
    },
    async setModel(model: RuntimeModelRef): Promise<void> {
      let resolved = resolveModelRef(model.providerId, model.modelId);
      if (!resolved) {
        await refreshModels?.();
        resolved = resolveModelRef(model.providerId, model.modelId);
      }
      if (!resolved) {
        throw new Error(`unknown model: ${model.providerId}/${model.modelId}`);
      }
      await session.setModel(resolved);
    },
    async setThinkingLevel(level: ThinkingLevel): Promise<void> {
      session.setThinkingLevel(level);
    },
    async revert(): Promise<void> {
      const users = session.getUserMessagesForForking?.() ?? [];
      const target = users.at(-1);
      if (!target) {
        throw new Error("nothing to revert");
      }
      revertedLeaf = session.sessionManager.getLeafId() ?? undefined;
      await session.navigateTree(target.entryId);
    },
    async unrevert(): Promise<void> {
      if (!revertedLeaf) {
        throw new Error("nothing to unrevert");
      }
      await session.navigateTree(revertedLeaf);
      revertedLeaf = undefined;
    },
    async executeBash(
      command: string,
      onChunk?: (chunk: string) => void,
      options?: { excludeFromContext?: boolean }
    ): Promise<{ exitCode?: number; cancelled: boolean; output: string }> {
      const raw = session as unknown as {
        executeBash?: (
          command: string,
          onChunk?: (chunk: string) => void,
          options?: {
            excludeFromContext?: boolean;
            operations?: BashOperations;
          }
        ) => Promise<{ exitCode?: number; cancelled: boolean; output: string }>;
      };
      if (typeof raw.executeBash !== "function") {
        // Returning an empty success here would tell the caller a command ran.
        throw new Error("This runtime session cannot execute shell commands");
      }
      const executeOptions = bashOperations
        ? { ...options, operations: bashOperations }
        : options;
      return raw.executeBash(command, onChunk, executeOptions);
    },
    dispose: () => {
      session.dispose();
      listeners.clear();
    },
  };
}
