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
  const agent = new Agent({
    initialState: {
      systemPrompt: "You are Thebe.",
      model: options.model,
      tools,
    },
    streamFn: options.streamFn,
    async beforeToolCall({ toolCall }) {
      if (allowed.has(toolCall.name)) {
        return undefined;
      }
      await audit?.append({
        method: toolCall.name,
        parameterHash: hashParameters(toolCall.arguments),
        responseBytes: 0,
        budgetConsumed: 0,
        redactionFired: false,
      });
      return { block: true, reason: `unknown tool: ${toolCall.name}` };
    },
  });

  return {
    toolNames(): string[] {
      return agent.state.tools.map((tool) => tool.name);
    },
    messages(): AgentMessage[] {
      return agent.state.messages;
    },
    async ask(input: string): Promise<string> {
      await agent.prompt(input);
      const last = agent.state.messages.at(-1);
      if (!last || last.role !== "assistant") {
        throw new Error("Ask did not produce an assistant reply");
      }
      return contentText(last.content);
    },
  };
}
