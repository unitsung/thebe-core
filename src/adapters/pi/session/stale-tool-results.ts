import { limitModelOutput } from "../../../agent/tools/model-output-limit.ts";

/**
 * Every model call resends the whole transcript, so a tool result costs its size once per later
 * call. A search or library listing the model has already answered from is rarely read again, yet
 * it kept being paid for at full size. These limits shorten such results for the model only; the
 * session record and the caller that ran the tool keep the full text.
 */
export const STALE_RESULT_CHARS = {
  /** Results from this turn that the model has already acted on. */
  sameTurn: 3_000,
  /** Results from earlier user turns, kept as a reminder of what was found. */
  earlierTurn: 1_200,
} as const;

type Block = { type: string; text?: string };
type TranscriptMessage = { role: string; content?: unknown };

const WRAPPER = /^(<tool_output[^>\n]*>\n)([\s\S]*?)(\n<\/tool_output>)$/;

function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const wrapped = WRAPPER.exec(text);
  // Bound the payload, not the wrapper, so JSON results stay parseable.
  if (wrapped)
    return `${wrapped[1]}${limitModelOutput(wrapped[2]!, limit)}${wrapped[3]}`;
  return limitModelOutput(text, limit);
}

function lastIndexOfRole(
  messages: readonly TranscriptMessage[],
  role: string
): number {
  for (let index = messages.length - 1; index >= 0; index--)
    if (messages[index]!.role === role) return index;
  return -1;
}

/**
 * Returns the transcript with already-consumed tool results shortened. Results after the last
 * assistant message are the batch the model has not answered yet and stay whole. Messages that
 * need no change are returned as the same objects.
 */
export function compactStaleToolResults<T extends TranscriptMessage>(
  messages: readonly T[],
  limits: { sameTurn: number; earlierTurn: number } = STALE_RESULT_CHARS
): T[] {
  const lastAssistant = lastIndexOfRole(messages, "assistant");
  const lastUser = lastIndexOfRole(messages, "user");
  return messages.map((message, index) => {
    if (
      message.role !== "toolResult" ||
      index > lastAssistant ||
      !Array.isArray(message.content)
    )
      return message;
    const earlier = index < lastUser;
    const limit = earlier ? limits.earlierTurn : limits.sameTurn;
    let changed = false;
    const content = (message.content as Block[]).map((block): Block => {
      if (block.type === "text" && typeof block.text === "string") {
        const text = shorten(block.text, limit);
        if (text === block.text) return block;
        changed = true;
        return { ...block, text };
      }
      // A picture from an earlier turn costs far more than its caption is worth.
      if (earlier && block.type === "image") {
        changed = true;
        return { type: "text", text: "[image from an earlier turn omitted]" };
      }
      return block;
    });
    return changed ? { ...message, content } : message;
  });
}

/** Pi extension (opt-in): shorten consumed tool results before each model call. */
export function createStaleToolResultExtension(
  env: NodeJS.ProcessEnv = process.env
) {
  const on = ["on", "1", "true", "yes"].includes(
    env.THEBE_TOOL_RESULT_COMPACTION?.trim().toLowerCase() ?? ""
  );
  return (pi: {
    on: (
      event: "context",
      handler: (event: { messages: any[] }) => unknown
    ) => unknown;
  }) => {
    // Rewriting a result the provider has already seen changes the request prefix and loses its
    // prompt cache from that point on, so this is opt-in.
    if (!on) return;
    pi.on("context", (event) => ({
      messages: compactStaleToolResults(event.messages),
    }));
  };
}
