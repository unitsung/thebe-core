import { randomUUID } from "node:crypto";
import {
  PI_BUILTIN_TOOLS,
  PI_RUNTIME_ID,
  type AgentRuntime,
  type CreateRuntimeSessionOptions,
  type RuntimeModel,
  type RuntimeModelRef,
} from "../../agent/runtime/interface.ts";
import { createFakeRuntimeAuth } from "./fake-auth.ts";
import {
  createFakeSession,
  type FakeInboundToolResult,
  type FakeSessionControls,
} from "./fake-session.ts";
import {
  FAKE_RUNTIME_MODELS,
  type FakeQueuedTurn,
  type FakeSessionState,
} from "./fixtures.ts";

export type FakeRuntimeOptions = {
  runtimeId?: string;
  models?: RuntimeModel[];
};

export type FakeRuntimeHarness = {
  runtime: AgentRuntime;
  queueTurns(turns: FakeQueuedTurn[]): void;
  apiKeys: Map<string, string>;
  oauthLogins: string[];
  compactCalls(): number;
  compactInstructions(): Array<string | undefined>;
  inboundToolResults(): FakeInboundToolResult[];
  snapshot(id: string): FakeSessionState;
};

export function createFakeRuntime(
  options: FakeRuntimeOptions = {},
): FakeRuntimeHarness {
  const sessions = new Map<string, FakeSessionState>();
  const queue: FakeQueuedTurn[] = [];
  const apiKeys = new Map<string, string>();
  const oauthLogins: string[] = [];
  const oauthPending = new Set<string>();
  const inboundToolResults: FakeInboundToolResult[] = [];
  let compactCallCount = 0;
  const compactInstructionLog: Array<string | undefined> = [];
  let quiesced = false;
  const livenessRegistry = new Map<string, () => boolean>();
  const models = options.models ?? FAKE_RUNTIME_MODELS;

  const sessionControls: FakeSessionControls = {
    models,
    queue,
    inboundToolResults,
    recordCompact(customInstructions?: string): void {
      compactCallCount += 1;
      compactInstructionLog.push(customInstructions);
    },
  };

  const auth = createFakeRuntimeAuth({
    apiKeys,
    oauthLogins,
    oauthPending,
  });

  function getState(id: string): FakeSessionState {
    const state = sessions.get(id);
    if (!state) {
      throw new Error(`unknown runtime session: ${id}`);
    }
    return state;
  }

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

  function makeSession(state: FakeSessionState) {
    return createFakeSession(state, sessionControls);
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
        resourceReloads: 0,
        probeReply:
          (create.builtinTools?.length ?? -1) === 0 &&
          create.customTools.length === 0
            ? "ok"
            : undefined,
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
        resourceReloads: 0,
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
    async deleteSession(runtimeSessionId: string): Promise<void> {
      livenessRegistry.delete(runtimeSessionId);
      sessions.delete(runtimeSessionId);
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
    registerSessionLiveness(
      sessionId: string,
      isActive: () => boolean,
    ): () => void {
      livenessRegistry.set(sessionId, isActive);
      return () => {
        livenessRegistry.delete(sessionId);
      };
    },
    reapInactiveSessions(): number {
      let reaped = 0;
      for (const [sessionId, isActive] of [...livenessRegistry.entries()]) {
        if (isActive()) {
          continue;
        }
        livenessRegistry.delete(sessionId);
        sessions.delete(sessionId);
        reaped += 1;
      }
      return reaped;
    },
  };

  return {
    runtime,
    queueTurns(turns: FakeQueuedTurn[]): void {
      queue.push(...turns);
    },
    apiKeys,
    oauthLogins,
    compactCalls(): number {
      return compactCallCount;
    },
    compactInstructions(): Array<string | undefined> {
      return compactInstructionLog.slice();
    },
    inboundToolResults(): FakeInboundToolResult[] {
      return inboundToolResults.slice();
    },
    snapshot(id: string): FakeSessionState {
      return getState(id);
    },
  };
}
