// Hard cap on what one tool result may add to the model's context.
// Applies to the model-facing text only; capability and MCP callers keep the full result.

/** Size `limitModelOutput` bounds to when it is called without a limit. */
export const MODEL_RESULT_CHAR_LIMIT = 12_000;
const MIN_LIMIT = 2_000;

/**
 * `THEBE_MODEL_RESULT_LIMIT`: an optional cap on the characters one custom tool result may add to
 * the context. Unset, empty, "0", "off", "none" or an invalid value means no cap, so Core behaves
 * as the Pi agent does and every result is sent as the tool produced it. A positive value below
 * the floor is raised to it so results stay usable.
 */
export function resolveModelResultLimit(raw: string | undefined): number {
  const value = raw?.trim().toLowerCase();
  if (!value || ["0", "off", "none", "false"].includes(value)) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(MIN_LIMIT, Math.trunc(parsed));
}
const STRING_LIMIT = 600;

/** Bound `text` to about `limit` characters, keeping JSON valid and saying what was left out. */
export function limitModelOutput(
  text: string,
  limit = MODEL_RESULT_CHAR_LIMIT
): string {
  if (text.length <= limit) return text;
  const json = parseJson(text);
  if (json !== undefined && typeof json === "object" && json !== null) {
    const bounded = boundJson(json, limit);
    if (bounded !== undefined) return bounded;
  }
  return limitPlainText(text, limit);
}

function parseJson(text: string): unknown {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Halve every array until the document fits; later items are dropped, never cut mid-item. */
function boundJson(value: object, limit: number): string | undefined {
  for (let keep = 64; keep >= 1; keep = Math.floor(keep / 2)) {
    const out = JSON.stringify(shrink(value, keep));
    if (out.length <= limit) return out;
    if (keep === 1) break;
  }
  return undefined;
}

function shrink(value: unknown, keep: number): unknown {
  if (typeof value === "string") {
    return value.length > STRING_LIMIT
      ? `${value.slice(0, STRING_LIMIT)}… [${value.length - STRING_LIMIT} chars omitted]`
      : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, keep).map((item) => shrink(item, keep));
    return value.length > keep
      ? [
          ...head,
          `… ${value.length - keep} more items omitted; narrow the request or page it`,
        ]
      : head;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        shrink(item, keep),
      ])
    );
  }
  return value;
}

/** Logs and prose: the end is the part that matters, so keep the tail. */
function limitPlainText(text: string, limit: number): string {
  const kept = text.slice(-limit);
  const lineStart = kept.indexOf("\n");
  const tail =
    lineStart > 0 && lineStart < kept.length / 4
      ? kept.slice(lineStart + 1)
      : kept;
  return `[… ${text.length - tail.length} earlier chars omitted; ask for a narrower range]\n${tail}`;
}
