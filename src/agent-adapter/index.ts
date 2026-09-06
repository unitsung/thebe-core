import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { contentText, type Model } from "@earendil-works/pi-ai";
import { createStreamGuard } from "../stream-guard/index.ts";
import {
  isFailureSentinel,
  thebeConvertToLlm,
  thebeTransformContext,
} from "./convert.ts";

export type ThebeToolExecution = "sequential";

export type AgentReply =
  | { kind: "ok"; text: string }
  | { kind: "sentinel"; errorMessage: string }
  | { kind: "missing" };

export function createAgentAdapter(options: {
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
  shouldStopAfterTurn?: () => Promise<boolean>;
  ttfbMs?: number;
  idleMs?: number;
  watchdogMs?: number;
  onStreamGuardEvent?: (kind: string) => void;
}) {
  const guard = createStreamGuard({
    ttfbMs: options.ttfbMs,
    idleMs: options.idleMs,
    watchdogMs: options.watchdogMs,
    onEvent: options.onStreamGuardEvent,
  });
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? "You are Thebe.",
      model: options.model,
      tools: options.tools,
    },
    streamFn: guard.wrapStreamFn(options.streamFn),
    getApiKey: options.getApiKey,
    toolExecution: options.toolExecution,
    convertToLlm: thebeConvertToLlm,
    transformContext: thebeTransformContext,
    beforeToolCall: options.beforeToolCall,
    shouldStopAfterTurn: options.shouldStopAfterTurn,
  });
  guard.setAbort(() => agent.abort());
  agent.subscribe((event) => {
    if (event.type === "agent_end") {
      guard.notifyAgentEnd();
    }
  });

  return {
    async prompt(input: string): Promise<void> {
      guard.beginRun();
      await agent.prompt(input);
    },
    abort(): void {
      guard.noteAbort();
      agent.abort();
    },
    subscribe(
      listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
    ): () => void {
      return agent.subscribe(listener);
    },
    toolExecution: options.toolExecution,
    toolNames(): string[] {
      return agent.state.tools.map((tool) => tool.name);
    },
    messages(): AgentMessage[] {
      return agent.state.messages;
    },
    systemPrompt(): string {
      return agent.state.systemPrompt;
    },
    wasForceKilled(): boolean {
      return guard.wasForceKilled();
    },
    lastReply(): AgentReply {
      for (let i = agent.state.messages.length - 1; i >= 0; i--) {
        const message = agent.state.messages[i];
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
  };
}

export { isFailureSentinel } from "./convert.ts";
