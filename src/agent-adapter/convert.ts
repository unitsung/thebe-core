import type {
  AgentMessage,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";

/**
 * Required on the type. Pi Agent defaults to "parallel"; omitting it
 * silently falls back and trips G25.
 */
export type ThebeToolExecution = "sequential";

export type ThebeAgentAdapterOptions = {
  systemPrompt: string;
  model: Model<string>;
  tools: AgentTool[];
  toolExecution: ThebeToolExecution;
};

/**
 * Always passed explicitly so no path falls back to Pi's default convertToLlm.
 * v0 has no custom message types; keep user / assistant / toolResult only.
 * Must not throw.
 */
export function thebeConvertToLlm(messages: AgentMessage[]): Message[] {
  try {
    return messages.filter(
      (message) =>
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult",
    ) as Message[];
  } catch {
    return messages.filter(
      (message) =>
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult",
    ) as Message[];
  }
}

/**
 * Strip trailing assistant messages whose stopReason is error/aborted.
 * Pi appends the new user prompt before calling this hook, so a trailing
 * user suffix is skipped while stripping, then kept (steering stays).
 * Do not repair orphan tool_use blocks.
 * Must not throw; on error return the original array.
 */
export function thebeTransformContext(
  messages: AgentMessage[],
): Promise<AgentMessage[]> {
  try {
    let end = messages.length;
    let userSuffix = 0;
    while (end > 0 && messages[end - 1]?.role === "user") {
      end -= 1;
      userSuffix += 1;
    }
    while (end > 0) {
      const last = messages[end - 1];
      if (
        last?.role === "assistant" &&
        (last.stopReason === "error" || last.stopReason === "aborted")
      ) {
        end -= 1;
        continue;
      }
      break;
    }
    if (end + userSuffix === messages.length) {
      return Promise.resolve(messages);
    }
    if (userSuffix === 0) {
      return Promise.resolve(messages.slice(0, end));
    }
    return Promise.resolve([
      ...messages.slice(0, end),
      ...messages.slice(messages.length - userSuffix),
    ]);
  } catch {
    return Promise.resolve(messages);
  }
}

/**
 * Agent.handleRunFailure() sentinel: empty text, stopReason error/aborted,
 * non-empty errorMessage. Not a provider reply — Ask treats it as failure.
 */
export function isFailureSentinel(message: AgentMessage): boolean {
  try {
    if (message.role !== "assistant") {
      return false;
    }
    const stopReason = (message as { stopReason?: unknown }).stopReason;
    if (stopReason !== "error" && stopReason !== "aborted") {
      return false;
    }
    const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
    if (typeof errorMessage !== "string" || errorMessage.length === 0) {
      return false;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content) || content.length !== 1) {
      return false;
    }
    const block = content[0] as { type?: unknown; text?: unknown };
    return block.type === "text" && block.text === "";
  } catch {
    return false;
  }
}
