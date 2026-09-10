import type { NormalizedEvent, RuntimeMessage } from "../../types.ts";
import { summarizeArgs } from "../../../tools/redaction.ts";

type AgentSessionEvent = {
  type: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  isError?: boolean;
  result?: unknown;
  partialResult?: unknown;
  reason?: string;
  aborted?: boolean;
  errorMessage?: string;
};

export function mapPiEvent(event: AgentSessionEvent): NormalizedEvent | undefined {
  switch (event.type) {
    case "message_update": {
      const inner = event.assistantMessageEvent as {
        type?: string;
        delta?: string;
      };
      if (inner.type === "text_delta" && inner.delta) {
        return { type: "text_delta", text: inner.delta };
      }
      if (inner.type === "thinking_delta" && inner.delta) {
        return { type: "thinking_delta", text: inner.delta };
      }
      return undefined;
    }
    case "tool_execution_start":
      return {
        type: "tool_start",
        toolName: event.toolName ?? "",
        toolCallId: event.toolCallId ?? "",
        args: redactedArgs(event.args),
      };
    case "tool_execution_update":
      return {
        type: "tool_update",
        toolName: event.toolName ?? "",
        toolCallId: event.toolCallId ?? "",
        text: toolText(event.partialResult ?? event),
        args: redactedArgs(event.args),
      };
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolName: event.toolName ?? "",
        toolCallId: event.toolCallId ?? "",
        isError: Boolean(event.isError),
        text: toolText(event.result),
        args: redactedArgs(event.args),
        details: resultDetails(event.result),
      };
    case "turn_end":
      return { type: "turn_end" };
    case "agent_end":
    case "agent_settled":
      return { type: "session_end", text: "" };
    case "compaction_start":
      return { type: "compaction_start", reason: event.reason };
    case "compaction_end": {
      const result = event.result as
        | { tokensBefore?: number; estimatedTokensAfter?: number }
        | undefined;
      return {
        type: "compaction_end",
        aborted: event.aborted,
        reason: event.reason,
        tokensBefore: result?.tokensBefore,
        estimatedTokensAfter: result?.estimatedTokensAfter,
        errorMessage: event.errorMessage,
      };
    }
    case "queue_update": {
      const queued = event as unknown as {
        steering?: unknown;
        followUp?: unknown;
      };
      const steering = Array.isArray(queued.steering)
        ? queued.steering.length
        : 0;
      const followUp = Array.isArray(queued.followUp)
        ? queued.followUp.length
        : 0;
      return { type: "queue_update", steering, followUp };
    }
    default:
      return undefined;
  }
}

export function mapPiMessages(messages: unknown[]): RuntimeMessage[] {
  const out: RuntimeMessage[] = [];
  let index = 0;
  for (const raw of messages) {
    const message = raw as {
      id?: string;
      role?: string;
      content?: unknown;
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
      errorMessage?: string;
    };
    const id = typeof message.id === "string" ? message.id : `pi-${index}`;
    index += 1;
    if (message.role === "user") {
      out.push({
        id,
        role: "user",
        text: contentToText(message.content),
        attachments: contentAttachments(message.content),
      });
      continue;
    }
    if (message.role === "assistant") {
      out.push({
        id,
        role: "assistant",
        text: contentToText(message.content) || message.errorMessage || "",
        attachments: contentAttachments(message.content),
      });
      continue;
    }
    if (message.role === "toolResult" || message.role === "tool") {
      out.push({
        id,
        role: "tool",
        text: contentToText(message.content),
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        isError: message.isError,
      });
    }
  }
  return out;
}

function contentAttachments(
  content: unknown,
): Array<{ mediaType?: string }> | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const found: Array<{ mediaType?: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const row = block as {
      type?: unknown;
      mediaType?: unknown;
      image_url?: unknown;
      source?: unknown;
    };
    const mediaType =
      typeof row.mediaType === "string"
        ? row.mediaType
        : typeof row.source === "object" && row.source !== null
          ? (row.source as { mediaType?: unknown }).mediaType
          : undefined;
    if (
      (typeof row.type === "string" && row.type.toLowerCase().includes("image")) ||
      row.image_url !== undefined ||
      (typeof mediaType === "string" && mediaType.startsWith("image/"))
    ) {
      found.push(
        typeof mediaType === "string" ? { mediaType } : {},
      );
    }
  }
  return found.length > 0 ? found : undefined;
}

function redactedArgs(args: unknown): unknown {
  if (args == null) {
    return undefined;
  }
  try {
    return JSON.parse(summarizeArgs(args, 8_000));
  } catch {
    return undefined;
  }
}

function resultDetails(value: unknown): unknown {
  if (value && typeof value === "object" && "details" in value) {
    return (value as { details?: unknown }).details;
  }
  return undefined;
}

function toolText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as {
      content?: unknown;
      result?: unknown;
      text?: unknown;
    };
    if (typeof record.text === "string") {
      return record.text;
    }
    if (record.content !== undefined) {
      return contentToText(record.content);
    }
    if (record.result !== undefined) {
      return toolText(record.result);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return value == null ? "" : String(value);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? "" : toolText(content);
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (block && typeof block === "object" && "text" in block) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}
