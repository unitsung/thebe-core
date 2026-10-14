/**
 * The size limits a service reports about a model in its own model list.
 *
 * Services disagree on the field names (OpenRouter nests them under `top_provider`, Gemini says
 * `inputTokenLimit`, vLLM says `max_model_len`, models.dev-style catalogues use `limit`). Only
 * a positive whole number counts; nothing is guessed when a service reports none, because an
 * invented window would be used for compaction and for how much the model is asked to write.
 */
export type ReportedLimits = { contextWindow?: number; maxTokens?: number };

const CONTEXT_KEYS = [
  "context_length",
  "context_window",
  "contextWindow",
  "max_context_length",
  "max_model_len",
  "inputTokenLimit",
  "max_input_tokens",
] as const;
const OUTPUT_KEYS = [
  "max_completion_tokens",
  "max_output_tokens",
  "outputTokenLimit",
  "max_tokens",
] as const;

function positiveInteger(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
}

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  const child = (value as Record<string, unknown> | null | undefined)?.[key];
  return child && typeof child === "object" && !Array.isArray(child) ? (child as Record<string, unknown>) : undefined;
}

function firstNumber(sources: Array<Record<string, unknown> | undefined>, keys: readonly string[]): number | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const found = positiveInteger(source[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function reportedLimits(row: unknown): ReportedLimits {
  if (!row || typeof row !== "object") return {};
  const record = row as Record<string, unknown>;
  const topProvider = objectAt(record, "top_provider");
  const limit = objectAt(record, "limit");
  // A nested provider entry describes what that provider will actually accept, so it goes first.
  const contextWindow =
    firstNumber([topProvider], ["context_length"]) ??
    firstNumber([record], CONTEXT_KEYS) ??
    firstNumber([limit], ["context"]);
  const maxTokens =
    firstNumber([topProvider], ["max_completion_tokens"]) ??
    firstNumber([record], OUTPUT_KEYS) ??
    firstNumber([limit], ["output"]);
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    // An output limit larger than the window is a contradiction; keep the window.
    ...(maxTokens !== undefined && (contextWindow === undefined || maxTokens <= contextWindow) ? { maxTokens } : {}),
  };
}
