import type { JudgmentModel } from "../../agent/judgment/interface.ts";
import type {
  JudgmentAnswer,
  JudgmentQuestion,
  JudgmentRequest,
  JudgmentResult,
} from "../../agent/judgment/types.ts";
import { DEFAULT_JEV_MODEL, DEFAULT_TYPESAFE_BASE_URL } from "../../agent/judgment/gate.ts";

export type JevAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;

export function createJevAdapter(options: JevAdapterOptions): JudgmentModel {
  const fetchFn = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_TYPESAFE_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    adapterId: "jev",
    async judge(request: JudgmentRequest): Promise<JudgmentResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        (timer as { unref(): void }).unref?.();
      }
      let response: Response;
      try {
        response = await fetchFn(baseUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model,
            state: request.state,
            questions: request.questions,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        throw new Error(
          error instanceof Error ? error.message : "Jev request failed",
        );
      }
      clearTimeout(timer);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Jev HTTP ${response.status}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new Error("Jev returned non-JSON");
      }
      return parseJevResult(body, request.questions);
    },
  };
}

function parseJevResult(
  body: unknown,
  questions: Record<string, JudgmentQuestion>,
): JudgmentResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Jev returned an invalid body");
  }
  const row = body as Record<string, unknown>;
  const answersRaw = row.answers;
  if (!answersRaw || typeof answersRaw !== "object" || Array.isArray(answersRaw)) {
    throw new Error("Jev returned no answers");
  }
  const answers: Record<string, JudgmentAnswer> = {};
  for (const id of Object.keys(questions)) {
    const parsed = parseAnswer(
      (answersRaw as Record<string, unknown>)[id],
      questions[id],
    );
    if (!parsed) {
      throw new Error(`Jev omitted answer ${id}`);
    }
    answers[id] = parsed;
  }
  return {
    adapter: "jev",
    model: typeof row.model === "string" ? row.model : DEFAULT_JEV_MODEL,
    answers,
  };
}

function parseAnswer(
  value: unknown,
  question: JudgmentQuestion | undefined,
): JudgmentAnswer | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !question) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (question.type === "noul") {
    const noul = typeof row.noul === "number" ? row.noul : Number(row.noul);
    if (!Number.isFinite(noul) || noul < 0 || noul > 1) return undefined;
    return { type: "noul", noul };
  }
  if (question.type === "choice") {
    if (typeof row.choice !== "string") return undefined;
    return {
      type: "choice",
      choice: row.choice,
      probabilities: numberMap(row.probabilities),
      confidence: finiteNumber(row.confidence, 0),
    };
  }
  const score = typeof row.score === "number" ? row.score : Number(row.score);
  if (!Number.isFinite(score)) return undefined;
  return {
    type: "score",
    score,
    probabilities: numberMap(row.probabilities),
    confidence: finiteNumber(row.confidence, 0),
  };
}

function numberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    const n = typeof item === "number" ? item : Number(item);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function finiteNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
