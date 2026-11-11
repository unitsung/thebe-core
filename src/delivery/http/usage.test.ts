import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import {
  BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS,
  createBackgroundBudgetService,
} from "../../agent/usage/budget.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

const DAY = 86_400_000;
const START = Date.parse("2026-10-01T12:00:00Z");

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("not used");
    },
    getContainerLogs: async () => "",
    getStatusSummary: async () => {
      throw new Error("not used");
    },
  };
}

async function setup() {
  const storeDir = await mkdtemp(join(tmpdir(), "thebe-usage-"));
  const budgetDir = join(storeDir, "usage");
  const seed = createBackgroundBudgetService({
    dir: budgetDir,
    now: () => new Date(START),
    startedAt: new Date(START).toISOString(),
    initialDailyTokens: 1_000,
  });
  for (
    let index = 0;
    index < BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS;
    index++
  ) {
    await seed.record({
      id: `seed-${index}`,
      at: new Date(START + index * DAY).toISOString(),
      input: (index + 1) * 10,
      output: 0,
      cacheWrite: 0,
    });
  }
  const now = START + BACKGROUND_BUDGET_SUGGESTION_AFTER_DAYS * DAY;
  const app = createThebeApp({
    runtime: createFakeRuntime().runtime,
    provider: provider(),
    agentStoreDir: storeDir,
    now: () => new Date(now),
  });
  return { app, now };
}

async function call(
  app: Awaited<ReturnType<typeof setup>>["app"],
  path: string,
  init?: RequestInit
) {
  const response = await app.handler.handle(
    new Request(`http://127.0.0.1:8787${path}`, init)
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

describe("background usage routes", () => {
  it("returns usage, estimated cost and a pending 15-day suggestion", async () => {
    const { app } = await setup();
    const result = await call(app, "/v1/usage/summary");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      day: "2026-10-16",
      budget: {
        dailyTokens: 1_000,
        paused: false,
      },
      suggestion: {
        status: "pending",
        basedOnDays: 15,
        p95Tokens: 150,
        dailyTokens: 300,
      },
    });
    expect(result.body.history).toHaveLength(30);
    expect(result.body.history.at(-2)).toMatchObject({
      day: "2026-10-15",
      input: 150,
      counted: 150,
      cost: 0,
    });
  });

  it("sets a budget and accepts or ignores the suggestion", async () => {
    const { app } = await setup();
    const paused = await call(app, "/v1/usage/budget", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dailyTokens: 0 }),
    });
    expect(paused.status).toBe(200);
    expect(paused.body.budget).toMatchObject({
      dailyTokens: 0,
      paused: true,
    });

    const updatedThresholds = await call(app, "/v1/usage/budget", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dailyTokens: 2_000, thresholds: [0.5, 0.85] }),
    });
    expect(updatedThresholds.status).toBe(200);
    expect(updatedThresholds.body.budget).toMatchObject({
      dailyTokens: 2_000,
      thresholds: [0.5, 0.85],
    });

    const accepted = await call(app, "/v1/usage/budget/suggestion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.budget.dailyTokens).toBe(300);
    expect(accepted.body.suggestion.status).toBe("accepted");
  });

  it("validates writes and does not allow reads to resolve a suggestion", async () => {
    const { app } = await setup();
    expect(
      await call(app, "/v1/usage/budget", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dailyTokens: -1 }),
      })
    ).toMatchObject({
      status: 400,
    });
    expect(
      await call(app, "/v1/usage/budget", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thresholds: "not-an-array" }),
      })
    ).toMatchObject({
      status: 400,
    });
    expect(
      await call(app, "/v1/usage/budget", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thresholds: [1.5] }),
      })
    ).toMatchObject({
      status: 400,
    });
    expect(
      await call(app, "/v1/usage/budget/suggestion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "maybe" }),
      })
    ).toMatchObject({
      status: 400,
    });
    expect(await call(app, "/v1/usage/budget/suggestion")).toMatchObject({
      status: 405,
    });
  });
});
