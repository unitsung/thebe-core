import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import type { ThebeSessionContext } from "../runtime/interface.ts";
import { httpError } from "../types.ts";

export const DEFAULT_DAILY_BACKGROUND_TOKEN_BUDGET = 1_000_000;
export const BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS = 15;
export const BACKGROUND_BUDGET_HISTORY_DAYS = 30;

const STORED_DAYS = 400;
const MAX_RECORDED_IDS_PER_DAY = 5_000;
const DAY_MS = 86_400_000;

export type BackgroundUsageTokens = {
  input: number;
  output: number;
  cacheWrite: number;
  /** Reported for visibility and never counted against the budget. */
  cacheRead: number;
  /** input + output + cacheWrite. */
  counted: number;
  /** Estimated USD cost reported by the runtime. */
  cost: number;
};

export type BackgroundBudgetNotice = {
  id: string;
  day: string;
  at: string;
  message: string;
};

export type BackgroundBudgetSuggestion = {
  id: string;
  status: "pending" | "accepted" | "ignored";
  basedOnDays: number;
  p95Tokens: number;
  dailyTokens: number;
  createdAt: string;
  resolvedAt?: string;
};

export type BackgroundBudgetSummary = {
  generatedAt: string;
  day: string;
  budget: {
    dailyTokens: number;
    remainingTokens: number;
    paused: boolean;
    resetsAt: string;
    pausedNotice?: string;
  };
  usage: BackgroundUsageTokens;
  history: Array<{ day: string } & BackgroundUsageTokens>;
  suggestion?: BackgroundBudgetSuggestion;
};

type StoredDay = BackgroundUsageTokens & {
  recordedIds: string[];
  notifiedAt?: string;
};

type StoredSuggestion = BackgroundBudgetSuggestion & {
  createdDay: string;
};

type LedgerState = {
  version: 1;
  startedAt: string;
  dailyTokens: number;
  days: Record<string, StoredDay>;
  suggestion?: StoredSuggestion;
};

export type RecordBackgroundUsageInput = {
  /** Stable per runtime session or run, so a retry cannot charge the same usage twice. */
  id: string;
  at?: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead?: number;
  cost?: number;
};

export type BackgroundBudgetService = {
  exhausted(): Promise<boolean>;
  record(input: RecordBackgroundUsageInput): Promise<boolean>;
  recordSession(input: {
    id: string;
    context: ThebeSessionContext;
    at?: string;
  }): Promise<boolean>;
  summary(): Promise<BackgroundBudgetSummary>;
  setDailyTokens(dailyTokens: number): Promise<BackgroundBudgetSummary>;
  resolveSuggestion(
    action: "accept" | "ignore"
  ): Promise<BackgroundBudgetSummary>;
};

/**
 * Durable accounting for autonomous model work. Only callers that classify work as background record
 * here, so the owner's chat remains outside this budget.
 */
export function createBackgroundBudgetService(options: {
  dir?: string;
  now: () => Date;
  initialDailyTokens?: number;
  onPaused?: (notice: BackgroundBudgetNotice) => Promise<void> | void;
  /** Test seam for a deterministic ledger start; production starts on first use. */
  startedAt?: string;
}): BackgroundBudgetService {
  const file = options.dir ? join(options.dir, "ledger.json") : undefined;
  const initialDailyTokens = normalizeDailyTokens(
    options.initialDailyTokens ?? DEFAULT_DAILY_BACKGROUND_TOKEN_BUDGET
  );
  let state: LedgerState | undefined;
  let chain = Promise.resolve();

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = chain.then(async () => {
      await load();
      return operation();
    });
    chain = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  async function load(): Promise<void> {
    if (state) return;
    if (file) {
      try {
        state = parseState(
          JSON.parse(await readFile(file, "utf8")),
          initialDailyTokens
        );
        return;
      } catch {
        // A missing or damaged ledger starts clean; the next write replaces it atomically.
      }
    }
    state = {
      version: 1,
      startedAt: options.startedAt ?? options.now().toISOString(),
      dailyTokens: initialDailyTokens,
      days: {},
    };
  }

  async function persist(): Promise<void> {
    if (!file || !state) return;
    await mkdir(options.dir!, { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(state)}\n`, "utf8");
  }

  function dayState(day: string): StoredDay {
    const current = state!.days[day];
    if (current) return current;
    const next: StoredDay = {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      counted: 0,
      cost: 0,
      recordedIds: [],
    };
    state!.days[day] = next;
    return next;
  }

  function currentDay(): string {
    return utcDay(options.now());
  }

  async function pausedNoticeIfNeeded(
    day: string
  ): Promise<BackgroundBudgetNotice | undefined> {
    const row = dayState(day);
    if (row.counted < state!.dailyTokens) return undefined;
    if (row.notifiedAt) return undefined;
    const at = options.now().toISOString();
    row.notifiedAt = at;
    await persist();
    return {
      id: `background-budget-paused-${day}`,
      day,
      at,
      message: `Automatic work is paused because today's ${state!.dailyTokens.toLocaleString(
        "en-US"
      )}-token budget is spent. It resumes tomorrow; your chat is not limited.`,
    };
  }

  async function notify(
    notice: BackgroundBudgetNotice | undefined
  ): Promise<void> {
    if (!notice || !options.onPaused) return;
    try {
      await options.onPaused(notice);
    } catch {
      // Accounting must not fail because a push transport is unavailable.
    }
  }

  async function ensureSuggestion(): Promise<void> {
    if (state!.suggestion) return;
    const today = currentDay();
    const startDay = utcDay(new Date(state!.startedAt));
    if (daysBetween(startDay, today) < BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS)
      return;
    const observed = Array.from(
      { length: BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS },
      (_, index) =>
        state!.days[
          addDays(today, index - BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS)
        ]?.counted ?? 0
    );
    if (!observed.some((value) => value > 0)) return;
    const p95Tokens = nearestRank(observed, 0.95);
    state!.suggestion = {
      id: `background-budget-suggestion-${today}`,
      status: "pending",
      basedOnDays: observed.length,
      p95Tokens,
      dailyTokens: Math.max(1, Math.ceil(p95Tokens * 2)),
      createdAt: options.now().toISOString(),
      createdDay: today,
    };
    await persist();
  }

  function summary(): BackgroundBudgetSummary {
    const now = options.now();
    const day = utcDay(now);
    const row = state!.days[day];
    const usage = usageOf(row);
    const paused = usage.counted >= state!.dailyTokens;
    const history = Array.from(
      { length: BACKGROUND_BUDGET_HISTORY_DAYS },
      (_, index) => {
        const key = addDays(day, index - BACKGROUND_BUDGET_HISTORY_DAYS + 1);
        return { day: key, ...usageOf(state!.days[key]) };
      }
    );
    return {
      generatedAt: now.toISOString(),
      day,
      budget: {
        dailyTokens: state!.dailyTokens,
        remainingTokens: Math.max(0, state!.dailyTokens - usage.counted),
        paused,
        resetsAt: `${addDays(day, 1)}T00:00:00.000Z`,
        ...(paused
          ? {
              pausedNotice:
                "Automatic work is paused until tomorrow. Your chat is not limited.",
            }
          : {}),
      },
      usage,
      history,
      ...(state!.suggestion
        ? { suggestion: publicSuggestion(state!.suggestion) }
        : {}),
    };
  }

  async function prune(): Promise<void> {
    const oldest = addDays(currentDay(), -STORED_DAYS);
    for (const day of Object.keys(state!.days)) {
      if (day < oldest) delete state!.days[day];
    }
  }

  async function recordUsage(
    input: RecordBackgroundUsageInput
  ): Promise<boolean> {
    return serial(async () => {
      const at = input.at ?? options.now().toISOString();
      const day = utcDay(new Date(at));
      const row = dayState(day);
      if (row.recordedIds.includes(input.id)) return false;
      const inputTokens = tokenCount(input.input);
      const outputTokens = tokenCount(input.output);
      const cacheWrite = tokenCount(input.cacheWrite);
      const cacheRead = tokenCount(input.cacheRead);
      row.input += inputTokens;
      row.output += outputTokens;
      row.cacheWrite += cacheWrite;
      row.cacheRead += cacheRead;
      row.counted += inputTokens + outputTokens + cacheWrite;
      row.cost += finiteNonNegative(input.cost);
      row.recordedIds.push(input.id);
      if (row.recordedIds.length > MAX_RECORDED_IDS_PER_DAY) {
        row.recordedIds.splice(
          0,
          row.recordedIds.length - MAX_RECORDED_IDS_PER_DAY
        );
      }
      await prune();
      await persist();
      const notice = await pausedNoticeIfNeeded(day);
      await notify(notice);
      return true;
    });
  }

  return {
    async exhausted() {
      return serial(async () => {
        const day = currentDay();
        const notice = await pausedNoticeIfNeeded(day);
        await notify(notice);
        return dayState(day).counted >= state!.dailyTokens;
      });
    },

    record: recordUsage,

    async recordSession(input) {
      const stats = input.context.sessionStats;
      if (!stats) return false;
      return recordUsage({
        id: input.id,
        ...(input.at ? { at: input.at } : {}),
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheWrite: stats.tokens.cacheWrite,
        cacheRead: stats.tokens.cacheRead,
        cost: stats.cost ?? input.context.estimatedCost?.amount,
      });
    },

    async summary() {
      return serial(async () => {
        await ensureSuggestion();
        await prune();
        await persist();
        const notice = await pausedNoticeIfNeeded(currentDay());
        await notify(notice);
        return summary();
      });
    },

    async setDailyTokens(dailyTokens) {
      const normalized = normalizeDailyTokens(dailyTokens);
      return serial(async () => {
        state!.dailyTokens = normalized;
        if (
          state!.suggestion &&
          state!.suggestion.status === "pending" &&
          normalized === state!.suggestion.dailyTokens
        ) {
          state!.suggestion.status = "accepted";
          state!.suggestion.resolvedAt = options.now().toISOString();
        }
        await persist();
        const notice = await pausedNoticeIfNeeded(currentDay());
        await notify(notice);
        return summary();
      });
    },

    async resolveSuggestion(action) {
      return serial(async () => {
        await ensureSuggestion();
        const suggestion = state!.suggestion;
        if (!suggestion) {
          throw httpError(
            409,
            "a budget suggestion is not available yet",
            "budget_suggestion_unavailable"
          );
        }
        if (suggestion.status !== "pending") {
          throw httpError(
            409,
            "the budget suggestion has already been resolved",
            "budget_suggestion_resolved"
          );
        }
        suggestion.status = action === "accept" ? "accepted" : "ignored";
        suggestion.resolvedAt = options.now().toISOString();
        if (action === "accept") {
          state!.dailyTokens = suggestion.dailyTokens;
        }
        await persist();
        const notice = await pausedNoticeIfNeeded(currentDay());
        await notify(notice);
        return summary();
      });
    },
  };
}

function parseState(value: unknown, fallbackDailyTokens: number): LedgerState {
  const input = value as Partial<LedgerState> | null;
  if (
    !input ||
    input.version !== 1 ||
    typeof input.startedAt !== "string" ||
    Number.isNaN(Date.parse(input.startedAt)) ||
    !input.days ||
    typeof input.days !== "object" ||
    Array.isArray(input.days)
  ) {
    throw new Error("invalid usage ledger");
  }
  const days: Record<string, StoredDay> = {};
  for (const [day, raw] of Object.entries(input.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const row = raw as Partial<StoredDay> | null;
    if (!row || typeof row !== "object") continue;
    const usage = {
      input: tokenCount(row.input),
      output: tokenCount(row.output),
      cacheWrite: tokenCount(row.cacheWrite),
      cacheRead: tokenCount(row.cacheRead),
      counted: tokenCount(row.counted),
      cost: finiteNonNegative(row.cost),
    };
    days[day] = {
      ...usage,
      // Older or hand-edited rows may disagree. The counted definition is authoritative.
      counted: usage.input + usage.output + usage.cacheWrite,
      recordedIds: Array.isArray(row.recordedIds)
        ? row.recordedIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0
          )
        : [],
      ...(typeof row.notifiedAt === "string"
        ? { notifiedAt: row.notifiedAt }
        : {}),
    };
  }
  const suggestion = parseSuggestion(input.suggestion);
  return {
    version: 1,
    startedAt: input.startedAt,
    dailyTokens:
      input.dailyTokens === undefined
        ? fallbackDailyTokens
        : normalizeDailyTokens(input.dailyTokens),
    days,
    ...(suggestion ? { suggestion } : {}),
  };
}

function parseSuggestion(value: unknown): StoredSuggestion | undefined {
  const row = value as Partial<StoredSuggestion> | null;
  if (
    !row ||
    typeof row.id !== "string" ||
    !["pending", "accepted", "ignored"].includes(row.status ?? "") ||
    typeof row.basedOnDays !== "number" ||
    !Number.isSafeInteger(row.basedOnDays) ||
    typeof row.p95Tokens !== "number" ||
    !Number.isSafeInteger(row.p95Tokens) ||
    typeof row.dailyTokens !== "number" ||
    !Number.isSafeInteger(row.dailyTokens) ||
    row.dailyTokens < 1 ||
    typeof row.createdAt !== "string" ||
    typeof row.createdDay !== "string"
  ) {
    return undefined;
  }
  return {
    id: row.id,
    status: row.status as StoredSuggestion["status"],
    basedOnDays: row.basedOnDays,
    p95Tokens: row.p95Tokens,
    dailyTokens: row.dailyTokens,
    createdAt: row.createdAt,
    createdDay: row.createdDay,
    ...(typeof row.resolvedAt === "string"
      ? { resolvedAt: row.resolvedAt }
      : {}),
  };
}

function publicSuggestion(input: StoredSuggestion): BackgroundBudgetSuggestion {
  const { createdDay: _createdDay, ...suggestion } = input;
  return { ...suggestion };
}

function usageOf(row: StoredDay | undefined): BackgroundUsageTokens {
  if (!row) {
    return {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      counted: 0,
      cost: 0,
    };
  }
  return {
    input: row.input,
    output: row.output,
    cacheWrite: row.cacheWrite,
    cacheRead: row.cacheRead,
    counted: row.input + row.output + row.cacheWrite,
    cost: Math.round(row.cost * 1e6) / 1e6,
  };
}

function normalizeDailyTokens(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw httpError(
      400,
      "dailyTokens must be a non-negative integer",
      "invalid_body"
    );
  }
  return value as number;
}

function tokenCount(value: unknown): number {
  const number = typeof value === "number" ? value : 0;
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function nearestRank(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] ?? 0;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + amount * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.floor(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      DAY_MS
  );
}
