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
    thresholds?: number[];
    dir?: string;
  } = {}
) {
  let now = options.start ?? START;
  const notices: BackgroundBudgetNotice[] = [];
  const thresholdNotices: BackgroundBudgetNotice[] = [];
  const allNotices: BackgroundBudgetNotice[] = [];
  const service = createBackgroundBudgetService({
    dir: options.dir,
    now: () => new Date(now),
    startedAt: new Date(START).toISOString(),
    initialDailyTokens: options.dailyTokens ?? 1_000,
    thresholds: options.thresholds,
    onPaused: (notice) => {
      notices.push(notice);
    },
    onThreshold: (notice) => {
      thresholdNotices.push(notice);
    },
    onNotice: (notice) => {
      allNotices.push(notice);
    },
  });
  return {
    service,
    notices,
    thresholdNotices,
    allNotices,
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

  it("notifies at 50%, 80%, 90% thresholds and pauses at 100%, deduplicated per day", async () => {
    const f = await setup({ dailyTokens: 1_000 });

    // 40% usage -> no notices yet
    await f.service.record({ id: "r1", input: 400, output: 0, cacheWrite: 0 });
    expect(f.thresholdNotices).toHaveLength(0);
    expect(f.notices).toHaveLength(0);

    // 50% usage -> triggers 50% threshold notice
    await f.service.record({ id: "r2", input: 100, output: 0, cacheWrite: 0 });
    expect(f.thresholdNotices).toHaveLength(1);
    expect(f.thresholdNotices[0]).toMatchObject({
      id: "background-budget-threshold-2026-10-01-50",
      threshold: 0.5,
      title: "Background budget at 50%",
    });
    expect(f.thresholdNotices[0]!.message).toContain(
      "50% of today's 1,000-token budget"
    );
    expect(f.notices).toHaveLength(0);

    // 80% usage -> triggers 80% threshold notice
    await f.service.record({ id: "r3", input: 300, output: 0, cacheWrite: 0 });
    expect(f.thresholdNotices).toHaveLength(2);
    expect(f.thresholdNotices[1]).toMatchObject({
      id: "background-budget-threshold-2026-10-01-80",
      threshold: 0.8,
      title: "Background budget at 80%",
    });

    // 90% usage -> triggers 90% threshold notice with approaching warning
    await f.service.record({ id: "r4", input: 100, output: 0, cacheWrite: 0 });
    expect(f.thresholdNotices).toHaveLength(3);
    expect(f.thresholdNotices[2]).toMatchObject({
      id: "background-budget-threshold-2026-10-01-90",
      threshold: 0.9,
      title: "Background budget at 90%",
    });
    expect(f.thresholdNotices[2]!.message).toContain(
      "approaching the daily limit"
    );

    // 100% usage -> triggers paused notice
    await f.service.record({ id: "r5", input: 100, output: 0, cacheWrite: 0 });
    expect(f.thresholdNotices).toHaveLength(3);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toMatchObject({
      id: "background-budget-paused-2026-10-01",
      threshold: 1.0,
      title: "Background work paused",
    });

    // Further records on same day do not re-emit any notices
    await f.service.record({ id: "r6", input: 50, output: 0, cacheWrite: 0 });
    expect(f.thresholdNotices).toHaveLength(3);
    expect(f.notices).toHaveLength(1);

    const summary = await f.service.summary();
    expect(summary.budget.thresholds).toEqual([0.5, 0.8, 0.9, 1.0]);
    expect(summary.budget.notifiedThresholds).toEqual([0.5, 0.8, 0.9, 1.0]);

    // Next UTC day resets triggered notices
    f.setNow(START + DAY);
    f.thresholdNotices.length = 0;
    f.notices.length = 0;

    await f.service.record({
      id: "day2-r1",
      input: 550,
      output: 0,
      cacheWrite: 0,
    });
    expect(f.thresholdNotices).toHaveLength(1);
    expect(f.thresholdNotices[0]!.id).toBe(
      "background-budget-threshold-2026-10-02-50"
    );
  });

  it("dispatches multiple notices in order when usage jumps across thresholds", async () => {
    const f = await setup({ dailyTokens: 1_000 });

    // Jump directly from 0% to 85%
    await f.service.record({
      id: "jump",
      input: 850,
      output: 0,
      cacheWrite: 0,
    });
    expect(f.thresholdNotices).toHaveLength(2);
    expect(f.thresholdNotices[0]!.threshold).toBe(0.5);
    expect(f.thresholdNotices[1]!.threshold).toBe(0.8);
  });

  it("respects custom configured thresholds and survives restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-budget-thresholds-"));
    const f = await setup({ dir, dailyTokens: 1_000, thresholds: [0.3, 0.7] });

    await f.service.record({ id: "r1", input: 350, output: 0, cacheWrite: 0 });
    expect(f.thresholdNotices).toHaveLength(1);
    expect(f.thresholdNotices[0]!.threshold).toBe(0.3);

    // Reopen service from disk
    const reopenedThresholdNotices: BackgroundBudgetNotice[] = [];
    const reopened = createBackgroundBudgetService({
      dir,
      now: () => new Date(START),
      initialDailyTokens: 1_000,
      onThreshold: (n) => {
        reopenedThresholdNotices.push(n);
      },
    });

    const summary = await reopened.summary();
    expect(summary.budget.thresholds).toEqual([0.3, 0.7]);
    expect(summary.budget.notifiedThresholds).toEqual([0.3]);

    // Record more usage to cross 0.7
    await reopened.record({ id: "r2", input: 400, output: 0, cacheWrite: 0 });
    expect(reopenedThresholdNotices).toHaveLength(1);
    expect(reopenedThresholdNotices[0]!.threshold).toBe(0.7);
  });

  it("supports dynamically updating thresholds via setThresholds and setDailyTokens", async () => {
    const f = await setup({ dailyTokens: 1_000 });

    const updated = await f.service.setThresholds([0.25, 0.75]);
    expect(updated.budget.thresholds).toEqual([0.25, 0.75]);

    const updatedWithBudget = await f.service.setDailyTokens(2_000, [0.4, 0.8]);
    expect(updatedWithBudget.budget.dailyTokens).toBe(2_000);
    expect(updatedWithBudget.budget.thresholds).toEqual([0.4, 0.8]);
  });
});
