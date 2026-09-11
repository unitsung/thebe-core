import { randomUUID } from "node:crypto";
import {
  PI_BUILTIN_TOOLS,
  PI_RUNTIME_ID,
  asPromptInput,
  type AgentRuntime,
  type CreateRuntimeSessionOptions,
  type CustomToolDefinition,
  type NormalizedEvent,
  type PromptInput,
  type RuntimeAuth,
  type RuntimeExport,
  type RuntimeMessage,
  type RuntimeModel,
  type RuntimeModelRef,
  type RuntimeProvider,
  type RuntimeSession,
  type ThinkingLevel,
  type BackgroundTask,
  type ThebeSessionContext,
  isInlineTextFile,
} from "./types.ts";
import { permissionRisk, summarizeArgs } from "../tools/redaction.ts";
import {
  isInlineTextAttachment,
  renderInlineTextFile,
  renderLinesSnippet,
} from "./prompt-files.ts";

export type FakeQueuedTurn =
  | { kind: "text"; text: string }
  | {
      kind: "tools";
      calls: Array<{ name: string; args?: unknown; id?: string }>;
    }
  | { kind: "hang" }
  | { kind: "error"; message: string };

type FakeSessionState = {
  id: string;
  messages: RuntimeMessage[];
  compacted: boolean;
  compactedAt?: string;
  lastCompactInstructions?: string;
  autoCompact: boolean;
  tools: CustomToolDefinition[];
  builtinTools: string[];
  enabledResources: CreateRuntimeSessionOptions["enabledResources"];
  model: RuntimeModelRef;
  thinkingLevel: ThinkingLevel;
  reverted: RuntimeMessage[] | undefined;
  permissionHandler?: CreateRuntimeSessionOptions["permissionHandler"];
  toolsRequiringApproval: string[];
  // Shared across resumed handles of the same underlying session, like abort
  // on a real runtime session: any handle's abort unblocks a hanging turn.
  abortWaiters: Array<() => void>;
  leafId?: string;
  toolAborts: Map<string, AbortController>;
};

export const FAKE_RUNTIME_MODELS: RuntimeModel[] = [
  {
    providerId: "fake",
    modelId: "fake-1",
    displayName: "Fake One",
    supportsThinking: true,
    available: true,
  },
  {
    providerId: "fake",
    modelId: "fake-2",
    displayName: "Fake Two",
    supportsThinking: false,
    available: true,
  },
  {
    providerId: "opencode",
    modelId: "muse-spark-1.3-free",
    displayName: "Muse Spark 1.3 Free",
    supportsThinking: true,
    available: true,
  },
  {
    providerId: "deepseek",
    modelId: "deepseek-chat",
    displayName: "DeepSeek Chat",
    supportsThinking: false,
    available: true,
  },
  {
    providerId: "deepseek",
    modelId: "deepseek-reasoner",
    displayName: "DeepSeek Reasoner",
    supportsThinking: true,
    available: true,
  },
  {
    providerId: "google",
    modelId: "gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash",
    supportsThinking: false,
    available: true,
  },
  {
    providerId: "anthropic",
    modelId: "claude-3-5-sonnet",
    displayName: "Claude 3.5 Sonnet",
    supportsThinking: true,
    available: true,
  },
];

const FAKE_RUNTIME_PROVIDERS: Array<
  Omit<RuntimeProvider, "authStatus">
> = [
  {
    id: "fake",
    displayName: "Fake",
    authMethods: ["apiKey", "oauth"],
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    authMethods: ["apiKey"],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    authMethods: ["apiKey"],
  },
  {
    id: "google",
    displayName: "Google",
    authMethods: ["oauth"],
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    authMethods: ["apiKey"],
  },
  {
    id: "emptyco",
    displayName: "Empty Co",
    authMethods: ["oauth"],
  },
];

export function createFakeRuntime(
  options: { runtimeId?: string; models?: RuntimeModel[] } = {},
) {
  const sessions = new Map<string, FakeSessionState>();
  const queue: FakeQueuedTurn[] = [];
  const apiKeys = new Map<string, string>();
  const oauthLogins: string[] = [];
  const oauthPending = new Set<string>();
  const inboundToolResults: Array<{
    toolName: string;
    text: string;
    isError: boolean;
  }> = [];
  let compactCalls = 0;
  const compactInstructions: Array<string | undefined> = [];
  let quiesced = false;

  function queueTurns(turns: FakeQueuedTurn[]): void {
    queue.push(...turns);
  }

  function getState(id: string): FakeSessionState {
    const state = sessions.get(id);
    if (!state) {
      throw new Error(`unknown runtime session: ${id}`);
    }
    return state;
  }

  function makeSession(state: FakeSessionState): RuntimeSession {
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

    async function runQueued(): Promise<void> {
      const turn = queue.shift();
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
          emit({
            type: "permission_requested",
            permissionId,
            toolName: call.name,
            toolCallId,
            argsSummary: summarizeArgs(call.args),
            risk: permissionRisk(call.name),
          });
          const decision = await state.permissionHandler.request({
            permissionId,
            toolName: call.name,
            toolCallId,
            args: call.args,
            argsSummary: summarizeArgs(call.args),
            risk: permissionRisk(call.name),
          });
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
        inboundToolResults.push({
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
      if (!aborted && queue.length > 0) {
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
        compactCalls += 1;
        compactInstructions.push(customInstructions);
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
      getForkMessages(): Array<{ entryId: string; text: string }> {
        return state.messages
          .filter((m) => m.role === "user" && m.text)
          .map((m) => ({ entryId: m.id, text: m.text ?? "" }));
      },
      async setModel(model: RuntimeModelRef): Promise<void> {
        const known = models.some(
          (row) =>
            row.providerId === model.providerId &&
            row.modelId === model.modelId,
        );
        if (!known) {
          throw new Error(
            `unknown model: ${model.providerId}/${model.modelId}`,
          );
        }
        state.model = model;
      },
      async setThinkingLevel(level: ThinkingLevel): Promise<void> {
        state.thinkingLevel = level;
      },
      async stopToolCall(toolCallId: string): Promise<void> {
        state.toolAborts.get(toolCallId)?.abort();
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
          (sum, m) => sum + (m.text?.length ?? 0),
          0,
        );
        const tokens = Math.ceil(totalChars / 4);
        let userMessages = 0;
        let assistantMessages = 0;
        let toolCalls = 0;
        let toolResults = 0;
        for (const m of state.messages) {
          if (m.role === "user") userMessages++;
          else if (m.role === "assistant") assistantMessages++;
          else if (m.role === "tool" || (m as { role?: string }).role === "toolResult") toolResults++;
          if (m.toolName) toolCalls++;
        }
        return {
          contextUsage: { usedTokens: tokens, maxTokens: 128_000 },
          estimatedCost: { amount: 0.001, currency: "USD" },
          compaction: {
            lastCompactedAt: state.compactedAt,
            nearThreshold:
              state.autoCompact && tokens > 128_000 - 16_384,
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
        return [];
      },
      async stopBackgroundTask(_taskId: string): Promise<void> {
        // no-op
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

  const models = options.models ?? FAKE_RUNTIME_MODELS;

  const auth: RuntimeAuth = {
    async setApiKey(providerId: string, apiKey: string): Promise<void> {
      apiKeys.set(providerId, apiKey);
    },
    async loginOAuth(providerId) {
      oauthLogins.push(providerId);
      return { kind: "oauth", providerId };
    },
    async authorizeOAuth(providerId) {
      if (apiKeys.has(providerId) || oauthLogins.includes(providerId)) {
        return { providerId, connected: true as const };
      }
      oauthPending.add(providerId);
      return {
        providerId,
        pending: true as const,
        url: `https://oauth.example/${providerId}/authorize`,
        instructions:
          "Complete login in your browser, then paste the redirect URL or code.",
        deviceCode: {
          userCode: `${providerId.toUpperCase()}-DEV`,
          verificationUri: `https://oauth.example/${providerId}/device`,
        },
      };
    },
    async submitOAuthCallback(providerId, input) {
      if (!oauthPending.has(providerId)) {
        throw new Error(`unknown OAuth authorization: ${providerId}`);
      }
      if (!input.trim()) {
        throw new Error("OAuth callback input required");
      }
      oauthPending.delete(providerId);
      if (!oauthLogins.includes(providerId)) {
        oauthLogins.push(providerId);
      }
    },
    async logout(providerId: string): Promise<void> {
      apiKeys.delete(providerId);
      const index = oauthLogins.indexOf(providerId);
      if (index >= 0) {
        oauthLogins.splice(index, 1);
      }
      oauthPending.delete(providerId);
    },
    async check(providerId: string) {
      return { ok: apiKeys.has(providerId) || oauthLogins.includes(providerId) };
    },
    async listProviders(): Promise<RuntimeProvider[]> {
      return FAKE_RUNTIME_PROVIDERS.map((provider) => ({
        ...provider,
        authStatus:
          apiKeys.has(provider.id) || oauthLogins.includes(provider.id)
            ? ("connected" as const)
            : ("missing" as const),
      }));
    },
    async testProvider(providerId: string): Promise<{ ok: boolean; message?: string }> {
      const ok = apiKeys.has(providerId) || oauthLogins.includes(providerId);
      return { ok, message: ok ? "Connected" : "Provider credentials not found" };
    },
  };

  function applyCreate(
    state: FakeSessionState,
    create: CreateRuntimeSessionOptions,
  ): void {
    state.tools = create.customTools;
    state.builtinTools = [...(create.builtinTools ?? state.builtinTools)];
    state.enabledResources = create.enabledResources;
    state.permissionHandler = create.permissionHandler;
    state.toolsRequiringApproval = [
      ...(create.toolsRequiringApproval ?? state.toolsRequiringApproval),
    ];
    if (typeof create.autoCompact === "boolean") {
      state.autoCompact = create.autoCompact;
    }
  }

  const runtime: AgentRuntime = {
    runtimeId: options.runtimeId ?? PI_RUNTIME_ID,
    async createSession(create: CreateRuntimeSessionOptions) {
      const id = randomUUID();
      const state: FakeSessionState = {
        id,
        messages: [],
        compacted: false,
        autoCompact: create.autoCompact ?? true,
        tools: create.customTools,
        builtinTools: [...(create.builtinTools ?? PI_BUILTIN_TOOLS)],
        enabledResources: create.enabledResources,
        model: create.model ?? models[0]!,
        thinkingLevel: "off",
        reverted: undefined,
        permissionHandler: create.permissionHandler,
        toolsRequiringApproval: [...(create.toolsRequiringApproval ?? [])],
        abortWaiters: [],
        toolAborts: new Map(),
      };
      if (!create.inMemory) {
        sessions.set(id, state);
      }
      return makeSession(state);
    },
    async resumeSession(runtimeSessionId, create) {
      const existing = getState(runtimeSessionId);
      applyCreate(existing, create);
      return makeSession(existing);
    },
    async listSessions() {
      return [...sessions.keys()].map((runtimeSessionId) => ({
        runtimeSessionId,
      }));
    },
    async forkSession(runtimeSessionId, create, fork) {
      const parent = getState(runtimeSessionId);
      const parentMessages = parent.messages.map((message) => ({ ...message }));
      let copied = parent.messages.map((message) => ({ ...message }));
      if (fork?.atEntryId) {
        const index = copied.findIndex(
          (message) => message.id === fork.atEntryId,
        );
        if (index < 0) {
          throw new Error(`unknown message: ${fork.atEntryId}`);
        }
        copied = copied.slice(0, index + 1);
      }
      if (fork?.mode === "branch_in_place") {
        applyCreate(parent, create);
        parent.leafId = fork.atEntryId ?? parent.messages.at(-1)?.id;
        parent.messages = parentMessages;
        return makeSession(parent);
      }
      const id = randomUUID();
      const state: FakeSessionState = {
        id,
        messages: copied,
        compacted: parent.compacted,
        compactedAt: parent.compactedAt,
        autoCompact: create.autoCompact ?? parent.autoCompact,
        tools: create.customTools,
        builtinTools: [...(create.builtinTools ?? parent.builtinTools)],
        enabledResources: create.enabledResources,
        model: { ...parent.model },
        thinkingLevel: parent.thinkingLevel,
        reverted: undefined,
        permissionHandler: create.permissionHandler,
        toolsRequiringApproval: [
          ...(create.toolsRequiringApproval ?? parent.toolsRequiringApproval),
        ],
        abortWaiters: [],
        toolAborts: new Map(),
        leafId: copied.at(-1)?.id,
      };
      sessions.set(id, state);
      parent.messages = parentMessages;
      return makeSession(state);
    },
    async listModels(query?: { providerId?: string }) {
      return models.filter(
        (model) =>
          !query?.providerId ||
          model.providerId.toLowerCase() === query.providerId.toLowerCase(),
      );
    },
    async listAvailableModels(query?: { providerId?: string }) {
      return models.filter(
        (model) =>
          model.available !== false &&
          (!query?.providerId ||
            model.providerId.toLowerCase() === query.providerId.toLowerCase()),
      );
    },
    async listProviders() {
      return auth.listProviders();
    },
    auth() {
      return auth;
    },
    async quiesce(): Promise<void> {
      quiesced = true;
    },
    async unquiesce(): Promise<void> {
      quiesced = false;
    },
    isQuiesced(): boolean {
      return quiesced;
    },
  };

  return {
    runtime,
    queueTurns,
    apiKeys,
    oauthLogins,
    compactCalls: () => compactCalls,
    compactInstructions: () => compactInstructions.slice(),
    inboundToolResults: () => inboundToolResults.slice(),
    snapshot(id: string) {
      return getState(id);
    },
  };
}

function lastAssistant(messages: RuntimeMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
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
