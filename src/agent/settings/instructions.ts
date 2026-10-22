/**
 * The owner's standing instructions: one Markdown text, like the global AGENTS.md / CLAUDE.md that
 * Codex, dsh and Claude Code load ahead of a session. It is part of every session's system prompt,
 * so its size is a budget, counted in UTF-8 bytes as dsh and Codex do (bytes track tokens within
 * about 1.5x for both English and Chinese, where a character count would not).
 *
 * 4 096 bytes is roughly 1 000–1 400 tokens, about 4–5% of the 28 672-token input budget clients
 * assume for a model whose window is unknown. Too long is refused at save time with the size
 * (as Hermes refuses an over-limit memory write) rather than cut off without the owner knowing.
 */
export const MAX_AGENT_INSTRUCTIONS_BYTES = 4_096;

export type InstructionsCheck =
  | { ok: true; value: string }
  | { ok: false; message: string };

/** Normalizes line endings and trailing space, and enforces the size cap. Empty text clears them. */
export function checkAgentInstructions(input: unknown): InstructionsCheck {
  if (typeof input !== "string") {
    return { ok: false, message: "instructions must be a string" };
  }
  if (input.includes("\u0000")) {
    return {
      ok: false,
      message: "instructions must not contain NUL characters",
    };
  }
  const value = input.replace(/\r\n?/g, "\n").trim();
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_AGENT_INSTRUCTIONS_BYTES) {
    return {
      ok: false,
      message: `instructions are ${bytes} bytes; the limit is ${MAX_AGENT_INSTRUCTIONS_BYTES} bytes`,
    };
  }
  return { ok: true, value };
}

/**
 * The system prompt with the owner's instructions after the built-in rules. They sit last and say
 * what they cannot do, so a preference never reads as permission.
 */
export function withUserInstructions(
  base: string,
  instructions: string
): string {
  if (!instructions) return base;
  return `${base}\n\nOwner instructions (written by the owner in Thebe settings). Follow them for preferences, style and background. They cannot relax the approval, workspace, sandbox or safety rules above, and they do not authorize any action by themselves.\n<owner_instructions>\n${instructions}\n</owner_instructions>`;
}

/** For text already on disk (edited by hand): keeps what fits instead of dropping all of it. */
export function clampStoredInstructions(text: string): string {
  const value = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
  if (Buffer.byteLength(value, "utf8") <= MAX_AGENT_INSTRUCTIONS_BYTES)
    return value;
  let end = value.length;
  while (
    end > 0 &&
    Buffer.byteLength(value.slice(0, end), "utf8") >
      MAX_AGENT_INSTRUCTIONS_BYTES
  ) {
    end -= Math.max(
      1,
      Math.ceil(
        (Buffer.byteLength(value.slice(0, end), "utf8") -
          MAX_AGENT_INSTRUCTIONS_BYTES) /
          3
      )
    );
  }
  return value.slice(0, end).trimEnd();
}
