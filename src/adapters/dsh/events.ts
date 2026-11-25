import type {
  NormalizedEvent,
  RuntimeMessage,
} from "../../agent/runtime/interface.ts";

export type DshSessionEventLike = {
  seq?: number;
  time?: number;
  type: string;
  data?: unknown;
};

export type MappedDshEvent = {
  events: NormalizedEvent[];
  message?: RuntimeMessage;
  assistantText?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textBlocks(value: unknown): { text: string; thinking: string } {
  const blocks = Array.isArray(value) ? value : [];
  const text: string[] = [];
  const thinking: string[] = [];
  for (const item of blocks) {
    const block = record(item);
    if (typeof block.text !== "string") continue;
    if (block.type === "text") text.push(block.text);
    if (block.type === "reasoning" || block.type === "thinking") {
      thinking.push(block.text);
    }
  }
  return { text: text.join(""), thinking: thinking.join("") };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Projects the durable DeepSeek Harness Session vocabulary into the events a
 * Thebe session subscriber already understands. Tool result events identify a
 * call rather than a tool, so the caller carries the call-to-name map.
 */
export function mapDshSessionEvent(
  input: DshSessionEventLike,
  toolNames: ReadonlyMap<string, string> = new Map()
): MappedDshEvent {
  const data = record(input.data);
  if (input.type === "assistant/message") {
    const message = record(data.message);
    const content = textBlocks(message.content);
    const events: NormalizedEvent[] = [];
    if (content.thinking) {
      events.push({ type: "thinking_delta", text: content.thinking });
    }
    if (content.text) {
      events.push({ type: "text_delta", text: content.text });
    }
    return {
      events,
      message: {
        id:
          typeof message.id === "string" ? message.id : `dsh-${input.seq ?? 0}`,
        role: "assistant",
        text: content.text,
        ...(content.thinking ? { thinking: content.thinking } : {}),
      },
      ...(content.text ? { assistantText: content.text } : {}),
    };
  }

  if (input.type === "tool/call") {
    const toolCallId =
      typeof data.callId === "string" ? data.callId : "unknown-tool-call";
    const toolName = typeof data.name === "string" ? data.name : "tool";
    const args = parseArguments(data.arguments);
    return {
      events: [
        {
          type: "tool_start",
          toolName,
          toolCallId,
          ...(args !== undefined ? { args } : {}),
        },
      ],
    };
  }

  if (input.type === "tool/result") {
    const message = record(data.message);
    const toolCallId =
      typeof message.toolCallId === "string"
        ? message.toolCallId
        : "unknown-tool-call";
    const toolName = toolNames.get(toolCallId) ?? "tool";
    const content = textBlocks(message.content);
    const isError = message.isError === true;
    return {
      events: [
        {
          type: "tool_end",
          toolName,
          toolCallId,
          isError,
          text: content.text,
        },
      ],
      message: {
        id:
          typeof message.id === "string" ? message.id : `dsh-${input.seq ?? 0}`,
        role: "tool",
        toolName,
        toolCallId,
        text: content.text,
        isError,
      },
    };
  }

  if (input.type === "turn/end") {
    return {
      events:
        record(data.reason).kind === "aborted"
          ? [{ type: "interrupted" }]
          : [{ type: "turn_end" }],
    };
  }

  if (input.type === "compaction/start") {
    return {
      events: [
        {
          type: "compaction_start",
          ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
        },
      ],
    };
  }

  if (input.type === "compaction/end") {
    return {
      events: [
        {
          type: "compaction_end",
          ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
        },
      ],
    };
  }

  return { events: [] };
}
