import type {
  CreateRuntimeSessionOptions,
  NormalizedEvent,
  PromptInput,
  RuntimeModelRef,
  RuntimeSession,
  ThinkingLevel,
  BackgroundTask,
  ThebeSessionContext,
} from "../../types.ts";
import {
  PI_BUILTIN_TOOLS,
  asPromptInput,
  isInlineTextFile,
} from "../../types.ts";
import { mapPiEvent, mapPiMessages } from "./map-events.ts";
import { exportPiSession } from "./pi-export.ts";
import type { PiSession } from "./pi-session.ts";
import { lastAssistantText } from "./pi-tools.ts";
import { DEFAULT_COMPACTION_RESERVE_TOKENS } from "../config/user-config.ts";
import type { PiModelShape } from "../config/model-shape.ts";

export function wrapSession(
  session: PiSession,
  create: CreateRuntimeSessionOptions,
  existingListeners: Set<(event: NormalizedEvent) => void> | undefined,
  resolveModelRef: (providerId: string, modelId: string) => PiModelShape | undefined,
  refreshModels?: () => Promise<void>,
): RuntimeSession {
  const listeners =
    existingListeners ?? new Set<(event: NormalizedEvent) => void>();
  let revertedLeaf: string | undefined;
  let lastCompactedAt: string | undefined;
  session.subscribe((event) => {
    const mapped = mapPiEvent(event as Parameters<typeof mapPiEvent>[0]);
    if (!mapped) {
      return;
    }
    if (mapped.type === "session_end") {
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
          file.mediaType.startsWith("image/"),
      )
      .map((file) => ({
        type: "image",
        source: {
          type: "base64",
          mediaType: file.mediaType,
          data: file.data!,
        },
      }));
    const inlined = (prompt.files ?? [])
      .filter(
        (file) =>
          (!file.mode || file.mode === "inline") &&
          file.data &&
          isInlineTextFile(file.mediaType),
      )
      .map((file) => {
        const name = file.filename ?? "attachment";
        let text: string;
        try {
          text = Buffer.from(file.data!, "base64").toString("utf8");
        } catch {
          text = "";
        }
        return `[file: ${name} (${file.mediaType})]\n${text}`;
      })
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
      .map(
        (file) =>
          `[file snippet: ${file.path ?? file.filename ?? "attachment"} lines ${file.lineRange?.start ?? 1}-${file.lineRange?.end ?? 1} (${file.mediaType})]`,
      )
      .join("\n");
    const otherFiles = (prompt.files ?? [])
      .filter(
        (file) =>
          (!file.mode || file.mode === "inline") &&
          !file.mediaType.startsWith("image/") &&
          !isInlineTextFile(file.mediaType),
      )
      .map(
        (file) =>
          `[file: ${file.filename ?? "attachment"} (${file.mediaType})]`,
      )
      .join("\n");
    const text = [prompt.text, inlined, references, lines, otherFiles]
      .filter((part) => part.length > 0)
      .join("\n");
    await session.prompt(text, images.length > 0 ? { images } : undefined);
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
      emit({
        type: "tool_end",
        toolName: "interrupted",
        toolCallId,
        isError: true,
        text: "tool call stopped by user",
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lastAssistantText: () => lastAssistantText(session),
    toolNames: () => [
      ...(create.builtinTools ?? PI_BUILTIN_TOOLS),
      ...create.customTools.map((tool) => tool.name),
    ],
    compact: async (customInstructions?: string) => {
      await session.compact(customInstructions);
    },
    exportSession: () => exportPiSession(session as never),
    messages: () => mapPiMessages(session.messages),
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
    async getContextUsage(): Promise<ThebeSessionContext> {
      const raw = (session as { getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined }).getContextUsage?.();
      const fallbackWindow =
        (session as { model?: { contextWindow?: number } }).model?.contextWindow ?? 1_048_576;
      const maxTokens = raw?.contextWindow ?? fallbackWindow;
      let usedTokens = raw?.tokens ?? 0;
      if (usedTokens === null || usedTokens === 0) {
        const msgs = mapPiMessages(session.messages);
        const chars = msgs.reduce((acc, m) => acc + (m.text?.length ?? 0), 0);
        usedTokens = Math.ceil(chars / 4);
      }
      const sessionStats = (session as { getSessionStats?: () => ThebeSessionContext["sessionStats"] }).getSessionStats?.();
      const sessionName = (session as { sessionManager?: { getSessionName?: () => string | undefined } }).sessionManager?.getSessionName?.();
      const costAmount = sessionStats?.cost ?? 0;
      const pathEntries =
        session.sessionManager.getBranch?.() ??
        session.sessionManager.getEntries?.() ??
        [];
      let compactedAt = lastCompactedAt;
      for (let i = pathEntries.length - 1; i >= 0; i--) {
        const entry = pathEntries[i];
        if (entry?.type === "compaction" && typeof entry.timestamp === "number") {
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
      return [];
    },
    async stopBackgroundTask(_taskId: string): Promise<void> {
      // no-op
    },
    async setModel(model: RuntimeModelRef): Promise<void> {
      let resolved = resolveModelRef(model.providerId, model.modelId);
      if (!resolved) {
        await refreshModels?.();
        resolved = resolveModelRef(model.providerId, model.modelId);
      }
      if (!resolved) {
        throw new Error(
          `unknown model: ${model.providerId}/${model.modelId}`,
        );
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
      options?: { excludeFromContext?: boolean },
    ): Promise<{ exitCode?: number; cancelled: boolean; output: string }> {
      const raw = session as unknown as {
        executeBash?: (
          command: string,
          onChunk?: (chunk: string) => void,
          options?: { excludeFromContext?: boolean },
        ) => Promise<{ exitCode?: number; cancelled: boolean; output: string }>;
      };
      if (typeof raw.executeBash === "function") {
        return raw.executeBash(command, onChunk, options);
      }
      return { exitCode: 0, cancelled: false, output: "" };
    },
    dispose: () => {
      session.dispose();
      listeners.clear();
    },
  };
}

