import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS,
  createBackgroundBudgetService,
  type BackgroundBudgetNotice,
} from "./budget.ts";

const DAY = 86_400_000;
const START = Date.parse("2026-10-01T12:00:00Z");

async function setup(
  options: {
    start?: number;
    dailyTokens?: number;
    dir?: string;
  } = {}
) {
  let now = options.start ?? START;
  const notices: BackgroundBudgetNotice[] = [];
  const service = createBackgroundBudgetService({
    dir: options.dir,
    now: () => new Date(now),
    startedAt: new Date(START).toISOString(),
    initialDailyTokens: options.dailyTokens ?? 1_000,
    onPaused: (notice) => {
      notices.push(notice);
    },
  });
  return {
    service,
    notices,
    advance(ms: number) {
      now += ms;
    },
    setNow(value: number) {
      now = value;
    },
  };
}

describe("background token budget", () => {
  it("counts input, output and cache writes but keeps cache reads separate", async () => {
    const f = await setup();
    await f.service.record({
      id: "eval-a",
      input: 400,
      output: 100,
      cacheWrite: 50,
      cacheRead: 9_000,
      cost: 0.0123456,
    });
    const summary = await f.service.summary();
    expect(summary.usage).toEqual({
      input: 400,
      output: 100,
      cacheWrite: 50,
      cacheRead: 9_000,
      counted: 550,
      cost: 0.012346,
    });
    expect(summary.budget).toMatchObject({
      dailyTokens: 1_000,
      remainingTokens: 450,
      paused: false,
    });
  });

  it("pauses at the limit, notifies once, and restores at the next UTC day", async () => {
    const f = await setup({ dailyTokens: 100 });
    await f.service.record({
      id: "worker-a",
      input: 80,
      output: 20,
      cacheWrite: 0,
    });
    expect(await f.service.exhausted()).toBe(true);
    expect(await f.service.exhausted()).toBe(true);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toMatchObject({
      id: "background-budget-paused-2026-10-01",
      day: "2026-10-01",
    });
    expect((await f.service.summary()).budget).toMatchObject({
      paused: true,
      pausedNotice:
        "Automatic work is paused until tomorrow. Your chat is not limited.",
    });

    f.setNow(Date.parse("2026-10-02T00:00:01Z"));
    expect(await f.service.exhausted()).toBe(false);
    expect((await f.service.summary()).budget.paused).toBe(false);
  });

  it("deduplicates a session charged twice and survives a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-budget-"));
    const first = await setup({ dir, dailyTokens: 500 });
    expect(
      await first.service.record({
        id: "subagent:one",
        input: 120,
        output: 30,
        cacheWrite: 10,
        cost: 0.01,
      })
    ).toBe(true);
    expect(
      await first.service.record({
        id: "subagent:one",
        input: 999,
        output: 999,
        cacheWrite: 999,
      })
    ).toBe(false);

    const reopened = createBackgroundBudgetService({
      dir,
      now: () => new Date(START),
      initialDailyTokens: 999_999,
    });
    const summary = await reopened.summary();
    expect(summary.budget.dailyTokens).toBe(500);
    expect(summary.usage.counted).toBe(160);
    expect(await readFile(join(dir, "ledger.json"), "utf8")).toContain(
      '"dailyTokens":500'
    );
  });

  it("does not repeat the paused notice after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-budget-notice-"));
    const first = await setup({ dir, dailyTokens: 10 });
    await first.service.record({
      id: "over",
      input: 10,
      output: 0,
      cacheWrite: 0,
    });
    expect(first.notices).toHaveLength(1);

    const notices: BackgroundBudgetNotice[] = [];
    const reopened = createBackgroundBudgetService({
      dir,
      now: () => new Date(START),
      onPaused: (notice) => {
        notices.push(notice);
      },
    });
    expect(await reopened.exhausted()).toBe(true);
    expect(notices).toEqual([]);
  });

  it("suggests twice the 15-day p95 once, and changes nothing until accepted", async () => {
    const f = await setup({ dailyTokens: 100 });
    for (
      let index = 0;
      index < BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS;
      index++
    ) {
      f.setNow(START + index * DAY);
      await f.service.record({
        id: `day-${index}`,
        input: (index + 1) * 10,
        output: 0,
        cacheWrite: 0,
      });
    }
    f.setNow(START + BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS * DAY);
    const summary = await f.service.summary();
    expect(summary.suggestion).toMatchObject({
      status: "pending",
      basedOnDays: 15,
      p95Tokens: 150,
      dailyTokens: 300,
    });
    expect(summary.budget.dailyTokens).toBe(100);
    expect((await f.service.summary()).suggestion?.id).toBe(
      summary.suggestion?.id
    );

    const ignored = await f.service.resolveSuggestion("ignore");
    expect(ignored.suggestion?.status).toBe("ignored");
    expect(ignored.budget.dailyTokens).toBe(100);
    await expect(f.service.resolveSuggestion("accept")).rejects.toMatchObject({
      status: 409,
      code: "budget_suggestion_resolved",
    });
  });

  it("accepting a higher suggestion resumes the same day without a second notice", async () => {
    const f = await setup({ dailyTokens: 100 });
    for (
      let index = 0;
      index < BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS;
      index++
    ) {
      f.setNow(START + index * DAY);
      await f.service.record({
        id: `day-${index}`,
        input: 100,
        output: 0,
        cacheWrite: 0,
      });
    }
    f.setNow(START + BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS * DAY);
    f.notices.length = 0;
    await f.service.record({
      id: "today",
      input: 100,
      output: 0,
      cacheWrite: 0,
    });
    expect(f.notices).toHaveLength(1);
    const accepted = await f.service.resolveSuggestion("accept");
    expect(accepted.budget.dailyTokens).toBe(200);
    expect(await f.service.exhausted()).toBe(false);
    expect(f.notices).toHaveLength(1);
  });
});
