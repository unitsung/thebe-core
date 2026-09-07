import { randomUUID } from "node:crypto";
import { PI_BUILTIN_TOOLS, PI_RUNTIME_ID } from "./types.ts";
import type {
  AgentRuntime,
  CreateRuntimeSessionOptions,
  CustomToolDefinition,
  NormalizedEvent,
  RuntimeAuth,
  RuntimeExport,
  RuntimeMessage,
  RuntimeSession,
} from "./types.ts";

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
  tools: CustomToolDefinition[];
  builtinTools: string[];
  enabledResources: CreateRuntimeSessionOptions["enabledResources"];
};

export function createFakeRuntime(options: { runtimeId?: string } = {}) {
  const sessions = new Map<string, FakeSessionState>();
  const queue: FakeQueuedTurn[] = [];
  const apiKeys = new Map<string, string>();
  const oauthLogins: string[] = [];
  let compactCalls = 0;

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
    let abortWaiters: Array<() => void> = [];

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
          abortWaiters.push(() => {
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
        state.messages.push({ role: "assistant", text: turn.text });
        emit({ type: "turn_end" });
        emit({ type: "session_end", text: turn.text });
        return;
      }
      for (const call of turn.calls) {
        if (aborted) {
          break;
        }
        const toolCallId = call.id ?? randomUUID();
        emit({ type: "tool_start", toolName: call.name, toolCallId });
        const tool = state.tools.find((item) => item.name === call.name);
        let text = "";
        let isError = false;
        if (!tool) {
          isError = true;
          text = `unknown tool: ${call.name}`;
        } else {
          try {
            const result = await tool.execute(
              toolCallId,
              call.args ?? {},
              undefined,
            );
            text = result.content.map((block) => block.text).join("\n");
            isError = Boolean(result.isError);
          } catch (error) {
            isError = true;
            text = error instanceof Error ? error.message : String(error);
          }
        }
        emit({
          type: "tool_end",
          toolName: call.name,
          toolCallId,
          isError,
          text,
        });
        state.messages.push({
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

    return {
      runtimeSessionId: state.id,
      async prompt(text: string): Promise<void> {
        aborted = false;
        state.messages.push({ role: "user", text });
        await runQueued();
      },
      async abort(): Promise<void> {
        aborted = true;
        const waiters = abortWaiters;
        abortWaiters = [];
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
      async compact(): Promise<void> {
        compactCalls += 1;
        emit({ type: "compaction_start", reason: "manual" });
        state.compacted = true;
        state.messages = [
          { role: "assistant", text: "[compacted]" },
          ...state.messages.slice(-2),
        ];
        emit({ type: "compaction_end", aborted: false });
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
      dispose(): void {
        listeners.clear();
      },
    };
  }

  const auth: RuntimeAuth = {
    async setApiKey(providerId: string, apiKey: string): Promise<void> {
      apiKeys.set(providerId, apiKey);
    },
    async loginOAuth(providerId) {
      oauthLogins.push(providerId);
      return { kind: "oauth", providerId };
    },
    async logout(providerId: string): Promise<void> {
      apiKeys.delete(providerId);
    },
    async check(providerId: string) {
      return { ok: apiKeys.has(providerId) || oauthLogins.includes(providerId) };
    },
  };

  const runtime: AgentRuntime = {
    runtimeId: options.runtimeId ?? PI_RUNTIME_ID,
    async createSession(create: CreateRuntimeSessionOptions) {
      const id = randomUUID();
      const state: FakeSessionState = {
        id,
        messages: [],
        compacted: false,
        tools: create.customTools,
        builtinTools: [...(create.builtinTools ?? PI_BUILTIN_TOOLS)],
        enabledResources: create.enabledResources,
      };
      sessions.set(id, state);
      return makeSession(state);
    },
    async resumeSession(runtimeSessionId, create) {
      const existing = getState(runtimeSessionId);
      existing.tools = create.customTools;
      existing.builtinTools = [
        ...(create.builtinTools ?? existing.builtinTools),
      ];
      return makeSession(existing);
    },
    async listSessions() {
      return [...sessions.keys()].map((runtimeSessionId) => ({
        runtimeSessionId,
      }));
    },
    async forkSession(runtimeSessionId, create) {
      const parent = getState(runtimeSessionId);
      const parentMessages = parent.messages.map((message) => ({ ...message }));
      const id = randomUUID();
      const state: FakeSessionState = {
        id,
        messages: parent.messages.map((message) => ({ ...message })),
        compacted: parent.compacted,
        tools: create.customTools,
        builtinTools: [...(create.builtinTools ?? parent.builtinTools)],
        enabledResources: create.enabledResources,
      };
      sessions.set(id, state);
      parent.messages = parentMessages;
      return makeSession(state);
    },
    auth() {
      return auth;
    },
  };

  return {
    runtime,
    queueTurns,
    apiKeys,
    oauthLogins,
    compactCalls: () => compactCalls,
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
