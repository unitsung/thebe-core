import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type CompactionSettings,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { createStreamGuard } from "../stream-guard/index.ts";
import {
  isFailureSentinel,
  thebeConvertToLlm,
  thebeTransformContext,
} from "./convert.ts";
import { wrapModelsForHarness } from "./models.ts";
import { toHarnessTool } from "./tools.ts";

export type ThebeToolExecution = "sequential";

export type AgentReply =
  | { kind: "ok"; text: string }
  | { kind: "sentinel"; errorMessage: string }
  | { kind: "missing" };

const MAIN_LANE = "main";

export function createAgentAdapter(options: {
  models: Models;
  model: Model<string>;
  streamFn: StreamFn;
  tools: AgentTool[];
  toolExecution: ThebeToolExecution;
  systemPrompt?: string;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  beforeToolCall?: (
    context: BeforeToolCallContext,
  ) => Promise<{ block?: boolean; reason?: string }>;
  afterToolCall?: (context: {
    toolCall: { name: string };
  }) => Promise<{ terminate?: boolean } | undefined>;
  shouldStopAfterTurn?: () => Promise<boolean>;
  ttfbMs?: number;
  idleMs?: number;
  watchdogMs?: number;
  onStreamGuardEvent?: (kind: string) => void;
  compaction?: CompactionSettings;
}) {
  const systemPrompt = options.systemPrompt ?? "You are Thebe.";
  const guard = createStreamGuard({
    ttfbMs: options.ttfbMs,
    idleMs: options.idleMs,
    watchdogMs: options.watchdogMs,
    onEvent: options.onStreamGuardEvent,
  });
  const context = BACKGROUND_CONTEXT;
  const listeners = new Set<
    (event: AgentEvent, signal: AbortSignal) => Promise<void> | void
  >();
  const beforeToolResults: Array<Record<string, unknown>> = [];
  const compactionReasons: string[] = [];
  let cachedMessages: AgentMessage[] = [];
  let currentOperationId: string | undefined;
  let abortRequested = false;

  const ready = startHarness();

  async function startHarness() {
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, context);
    const wrapped = wrapModelsForHarness(
      options.models,
      guard.wrapStreamFn(options.streamFn),
      options.getApiKey,
    );
    const { harness } = await AgentHarness.create(
      {
        session,
        models: wrapped,
        model: options.model,
        tools: options.tools.map(toHarnessTool),
        toolExecution: options.toolExecution,
        systemPrompt,
        toProviderMessages: (messages) => thebeConvertToLlm(messages),
        compaction: options.compaction ?? {
          enabled: true,
          reserveTokens: 16_384,
          keepRecentTokens: 20_000,
        },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      },
      context,
    );
    const lane = await harness.lane(MAIN_LANE, context);

    harness.hooks.on("transform_context", async (event) => {
      const messages = await thebeTransformContext(event.messages);
      return { messages };
    });
    harness.hooks.on("before_tool", async (event) => {
      const mapped = await options.beforeToolCall?.({
        toolCall: { name: event.toolName },
      } as BeforeToolCallContext);
      if (mapped) {
        beforeToolResults.push({ ...mapped });
      }
      if (mapped?.block) {
        return {
          block: {
            reason: mapped.reason ?? "blocked",
          },
        };
      }
      return undefined;
    });
    harness.hooks.on("after_tool", async (event) => {
      const mapped = await options.afterToolCall?.({
        toolCall: { name: event.toolName },
      });
      if (mapped?.terminate !== undefined) {
        return { terminate: mapped.terminate };
      }
      return undefined;
    });
    harness.events.on("run_start", (event) => {
      currentOperationId = event.runId;
      abortRequested = false;
    });
    harness.events.on("compaction_start", (event) => {
      compactionReasons.push(event.reason);
    });
    harness.events.on("turn_end", () => {
      // Do not await requestAbort here: emit delivery runs inside a lane
      // command, and abort also commands the lane (deadlock).
      void (async () => {
        if (await options.shouldStopAfterTurn?.()) {
          abortRequested = true;
          const id = currentOperationId;
          if (id) {
            await lane.requestAbort(id, context);
          }
        }
      })();
    });
    harness.events.on("run_end", async (event, ctx) => {
      currentOperationId = undefined;
      await refreshMessages();
      guard.notifyAgentEnd();
      const signal = ctx.abortSignal ?? new AbortController().signal;
      for (const listener of listeners) {
        await listener({ type: "agent_end", messages: cachedMessages }, signal);
      }
      void event;
    });

    guard.setAbort(async () => {
      abortRequested = true;
      const id = currentOperationId;
      if (!id) {
        return;
      }
      await lane.requestAbort(id, context);
    });

    return { harness, lane, session, repo };
  }

  async function refreshMessages(): Promise<void> {
    const { lane } = await ready;
    const entries = await lane.findEntries(
      { order: "oldestFirst" },
      context,
    );
    cachedMessages = [];
    for (const entry of entries) {
      if (entry.type === "message") {
        cachedMessages.push(entry.message);
      }
    }
  }

  return {
    toolExecution: options.toolExecution,
    async prompt(input: string): Promise<void> {
      const { lane } = await ready;
      guard.beginRun();
      abortRequested = false;
      await lane.prompt(input, undefined, context);
      await refreshMessages();
    },
    abort(): void {
      guard.noteAbort();
      abortRequested = true;
      void ready.then(async ({ lane }) => {
        const id = currentOperationId;
        if (id) {
          await lane.requestAbort(id, context);
          return;
        }
        await lane.abort(context);
      });
    },
    subscribe(
      listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
    ): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toolNames(): string[] {
      return options.tools.map((tool) => tool.name);
    },
    messages(): AgentMessage[] {
      return cachedMessages;
    },
    systemPrompt(): string {
      return systemPrompt;
    },
    wasForceKilled(): boolean {
      return guard.wasForceKilled();
    },
    lastReply(): AgentReply {
      for (let i = cachedMessages.length - 1; i >= 0; i--) {
        const message = cachedMessages[i];
        if (message?.role !== "assistant") {
          continue;
        }
        if (isFailureSentinel(message)) {
          const errorMessage =
            "errorMessage" in message &&
            typeof message.errorMessage === "string" &&
            message.errorMessage.length > 0
              ? message.errorMessage
              : "Ask run failed";
          return { kind: "sentinel", errorMessage };
        }
        return {
          kind: "ok",
          text: "content" in message ? contentText(message.content) : "",
        };
      }
      return { kind: "missing" };
    },
    beforeToolResults(): Array<Record<string, unknown>> {
      return beforeToolResults.slice();
    },
    compactionReasons(): string[] {
      return compactionReasons.slice();
    },
    async forkBranch(name: string, at?: string | null) {
      const { session, lane } = await ready;
      const tip = at === undefined ? await lane.getTipId(context) : at;
      return session.createBranch(name, tip, context);
    },
    async appendOnBranch(name: string, message: AgentMessage): Promise<void> {
      const { session } = await ready;
      const branch = await session.branch(name, context);
      if (!branch) {
        throw new Error(`unknown branch: ${name}`);
      }
      await branch.appendMessage(message, context);
    },
    async branchMessages(name: string): Promise<AgentMessage[]> {
      const { session } = await ready;
      const branch = await session.branch(name, context);
      if (!branch) {
        return [];
      }
      const entries = await branch.findEntries(
        { order: "oldestFirst" },
        context,
      );
      return entries
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);
    },
    async refresh(): Promise<void> {
      await refreshMessages();
    },
    wasAbortRequested(): boolean {
      return abortRequested;
    },
  };
}

export { isFailureSentinel } from "./convert.ts";
