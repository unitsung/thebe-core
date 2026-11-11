import { randomUUID } from "node:crypto";

export const DEFAULT_MAX_PROACTIVE_WORDS = 100;
export const MAX_PROACTIVE_WORDS = DEFAULT_MAX_PROACTIVE_WORDS;

export type SanitizeOptions = {
  mode?: "shorten" | "refuse";
  maxWords?: number;
};

export type ProactiveNotice = {
  id: string;
  body: string;
  summary?: string;
  ticketId?: string;
  deepLink?: string;
};

/**
 * Counts words or linguistic units in a string.
 * Supports Latin whitespace-delimited words and CJK ideographic characters.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const matches = trimmed.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[a-zA-Z0-9_-]+/gu
  );
  return matches ? matches.length : trimmed.split(/\s+/).filter(Boolean).length;
}

/**
 * Strips tool logs, command output blocks, and execution artifacts from proactive messages.
 * A message about a result must only contain readable prose, never raw tool logs.
 */
export function stripToolLogs(text: string): string {
  // 1. Strip fenced code blocks (especially logs, bash, shell, json output)
  let cleaned = text.replace(
    /```(?:log|bash|sh|shell|output|json)?\s*[\r\n]+[\s\S]*?```/gi,
    ""
  );

  // 2. Strip lines that look like tool call headers, stdout/stderr headers, or exit codes
  cleaned = cleaned
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (
        /^(?:\[tool_call(?::|\s)|tool\s+call:|tool\s+<[^>]+>|tool\s+[a-z0-9_-]+\s+(?:returned|called)|stdout:|stderr:|exit\s+code\s+\d+|===\s*(?:output|logs?)\s*===)/i.test(
          trimmed
        )
      ) {
        return false;
      }
      return true;
    })
    .join("\n");

  // 3. Normalize multiple blank lines and trim
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Shortens text to at most maxWords tokens, preferring clean sentence boundaries
 * and falling back to a word cutoff with an ellipsis.
 */
export function shortenToWords(
  text: string,
  maxWords = MAX_PROACTIVE_WORDS
): string {
  const trimmed = text.trim();
  if (countWords(trimmed) <= maxWords) return trimmed;

  // Try to find a sentence boundary that ends a complete thought within [0.5 * maxWords, maxWords].
  const sentenceEndPattern = /([。！？!?]|\.\s+|\n+)/g;
  let match: RegExpExecArray | null;
  let bestCutoff = -1;
  while ((match = sentenceEndPattern.exec(trimmed)) !== null) {
    const candidate = trimmed.slice(0, match.index + match[0].length).trim();
    const count = countWords(candidate);
    if (count >= Math.floor(maxWords * 0.5) && count <= maxWords) {
      bestCutoff = match.index + match[0].length;
    } else if (count > maxWords) {
      break;
    }
  }

  if (bestCutoff > 0) {
    return trimmed.slice(0, bestCutoff).trim();
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return `${words.slice(0, maxWords).join(" ")}…`;
  }
  return `${trimmed.slice(0, maxWords)}…`;
}

/**
 * Sanitizes a proactive message:
 * 1. Strips any tool log text.
 * 2. Checks word count.
 * 3. Shortens to 100 words or refuses if mode is 'refuse'.
 */
export function sanitizeProactiveMessage(
  text: string,
  options: SanitizeOptions = {}
): { ok: true; body: string } | { ok: false; reason: string } {
  const maxWords = options.maxWords ?? MAX_PROACTIVE_WORDS;
  const mode = options.mode ?? "shorten";
  const cleaned = stripToolLogs(text);
  if (!cleaned) {
    return {
      ok: false,
      reason: "message carries no content after removing tool logs",
    };
  }
  const words = countWords(cleaned);
  if (words > maxWords) {
    if (mode === "refuse") {
      return {
        ok: false,
        reason: `proactive message over ${maxWords} words (${words} words) is refused`,
      };
    }
    return { ok: true, body: shortenToWords(cleaned, maxWords) };
  }
  return { ok: true, body: cleaned };
}

/**
 * Workers cannot send messages to the owner directly (asserted).
 * Only the resident or person-facing Main Session is authorized to voice messages to the owner.
 */
export function assertWorkerCannotMessageOwner(callerRole: string): void {
  if (callerRole !== "main-session") {
    throw new Error("Workers cannot send messages to the owner directly");
  }
}

/**
 * Determines whether resident batch text is simply a dismissive/routine acknowledgment
 * stating nothing is needed, rather than an actionable message.
 */
export function isNoActionNeeded(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (!lower) return true;
  return (
    lower.includes("nothing needs the person") ||
    lower.includes("no tool action is justified") ||
    lower.includes("no action is needed") ||
    lower.includes("no action required") ||
    lower.includes("all systems normal")
  );
}

export function createProactiveMessageTool(options: {
  maxWords?: number;
  onProactiveMessage?: (notice: ProactiveNotice) => Promise<void> | void;
}) {
  return {
    name: "proactive_message",
    label: "proactive_message",
    description:
      "Send a brief proactive notice directly to the person about an actionable result or condition. Do not repeat tool logs.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Readable message for the person, focused on action or results, without tool logs.",
        },
        summary: {
          type: "string",
          description:
            "Optional concise 1-sentence summary (under 30 words) for lock-screen push notifications.",
        },
        ticketId: {
          type: "string",
          description:
            "Optional Ticket ID if this notice pertains to a specific ticket.",
        },
        mode: {
          type: "string",
          enum: ["shorten", "refuse"],
          description:
            "Whether to shorten a message over the word limit or refuse it. Defaults to shorten.",
        },
      },
      required: ["message"],
    },
    exposure: "direct" as const,
    requiresApproval: false,
    invoke(_toolCallId: string, input: unknown, callerRole = "main-session") {
      assertWorkerCannotMessageOwner(callerRole);
      const args = (input && typeof input === "object" ? input : {}) as {
        message?: string;
        summary?: string;
        ticketId?: string;
        mode?: "shorten" | "refuse";
      };
      const messageText = typeof args.message === "string" ? args.message : "";
      const sanitized = sanitizeProactiveMessage(messageText, {
        mode: args.mode,
        maxWords: options.maxWords,
      });
      if (!sanitized.ok) {
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, error: sanitized.reason }),
            },
          ],
          details: {},
        });
      }
      const summaryText =
        typeof args.summary === "string" && args.summary.trim()
          ? stripToolLogs(args.summary.trim())
          : undefined;
      const id = `proactive:${randomUUID()}`;
      const deepLink = args.ticketId
        ? `thebe://ticket/${encodeURIComponent(args.ticketId)}`
        : "thebe://main-session";
      return Promise.resolve(
        options.onProactiveMessage?.({
          id,
          body: sanitized.body,
          ...(summaryText ? { summary: summaryText } : {}),
          ticketId: args.ticketId,
          deepLink,
        })
      ).then(() => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, id, message: sanitized.body }),
          },
        ],
        details: {},
      }));
    },
    execute(_toolCallId: string, input: unknown) {
      return this.invoke(_toolCallId, input, "main-session");
    },
  };
}
