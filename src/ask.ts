import {
  Agent,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { contentText, type Model } from "@earendil-works/pi-ai";
import { createAuditLog, hashParameters } from "./audit/audit-log.ts";
import { createPolicyEngine } from "./policy/policy-engine.ts";
import type { ContainerInfoProvider } from "./providers/index.ts";
import {
  CONTAINER_TOOL_NAMES,
  createContainerTools,
} from "./tools/container-tools.ts";

export function createThebeAgent(options: {
  model: Model<string>;
  streamFn: StreamFn;
  provider: ContainerInfoProvider;
  auditPath?: string;
  now?: () => Date;
  callerId?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}) {
  const now = options.now ?? (() => new Date());
  const callerId = options.callerId ?? "default";
  const policy = createPolicyEngine({ now });
  const audit = options.auditPath
    ? createAuditLog(options.auditPath, now)
    : undefined;
  const tools = createContainerTools(options.provider, {
    policy,
    audit,
    callerId,
  });
  const allowed = new Set<string>(CONTAINER_TOOL_NAMES);
  const auditedUnknown = new Set<string>();
  const agent = new Agent({
    initialState: {
      systemPrompt: "You are Thebe.",
      model: options.model,
      tools,
    },
    streamFn: options.streamFn,
    getApiKey: options.getApiKey,
  });

  async function auditUnknownToolResults(messages: AgentMessage[]): Promise<void> {
    if (!audit) {
      return;
    }
    for (const message of messages) {
      if (message.role !== "toolResult" || !message.isError) {
        continue;
      }
      if (allowed.has(message.toolName)) {
        continue;
      }
      if (auditedUnknown.has(message.toolCallId)) {
        continue;
      }
      auditedUnknown.add(message.toolCallId);
      await audit.append({
        method: message.toolName,
        parameterHash: hashParameters(
          argumentsForToolCall(messages, message.toolCallId),
        ),
        responseBytes: 0,
        budgetConsumed: 0,
        redactionFired: false,
      });
    }
  }

  return {
    toolNames(): string[] {
      return agent.state.tools.map((tool) => tool.name);
    },
    messages(): AgentMessage[] {
      return agent.state.messages;
    },
    async ask(input: string): Promise<string> {
      await agent.prompt(input);
      await auditUnknownToolResults(agent.state.messages);
      const last = agent.state.messages.at(-1);
      if (!last || last.role !== "assistant") {
        throw new Error("Ask did not produce an assistant reply");
      }
      return contentText(last.content);
    },
  };
}

function argumentsForToolCall(
  messages: AgentMessage[],
  toolCallId: string,
): unknown {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "toolCall" &&
        "id" in block &&
        block.id === toolCallId &&
        "arguments" in block
      ) {
        return block.arguments;
      }
    }
  }
  return {};
}
