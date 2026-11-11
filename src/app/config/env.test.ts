import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseDailyBackgroundTokenBudget,
  parseDailyBackgroundTokenBudgetThresholds,
} from "../bootstrap.ts";
import { envLocalCandidates, loadEnvLocal } from "./env.ts";

describe("loadEnvLocal", () => {
  it("walks up from a nested dist/chunks path to the package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "thebe-env-"));
    const nested = join(root, "dist", "chunks");
    await mkdir(nested, { recursive: true });
    const key = `THEBE_ENV_TEST_${Date.now()}`;
    await writeFile(join(root, ".env.local"), `${key}=from-root\n`, "utf8");
    expect(envLocalCandidates(nested)).toContain(join(root, ".env.local"));
    expect(envLocalCandidates(nested)).toContain(join(nested, ".env.local"));
    delete process.env[key];
    loadEnvLocal(nested);
    expect(process.env[key]).toBe("from-root");
    delete process.env[key];
  });
});

describe("budget environment parsing", () => {
  it("parses THEBE_BACKGROUND_TOKEN_BUDGET", () => {
    expect(parseDailyBackgroundTokenBudget({})).toBeUndefined();
    expect(
      parseDailyBackgroundTokenBudget({ THEBE_BACKGROUND_TOKEN_BUDGET: "" })
    ).toBeUndefined();
    expect(
      parseDailyBackgroundTokenBudget({
        THEBE_BACKGROUND_TOKEN_BUDGET: "invalid",
      })
    ).toBeUndefined();
    expect(
      parseDailyBackgroundTokenBudget({
        THEBE_BACKGROUND_TOKEN_BUDGET: "500000",
      })
    ).toBe(500000);
    expect(
      parseDailyBackgroundTokenBudget({ THEBE_BACKGROUND_TOKEN_BUDGET: "0" })
    ).toBe(0);
  });

  it("parses THEBE_BACKGROUND_TOKEN_BUDGET_THRESHOLDS supporting decimals and percentages", () => {
    expect(parseDailyBackgroundTokenBudgetThresholds({})).toBeUndefined();
    expect(
      parseDailyBackgroundTokenBudgetThresholds({
        THEBE_BACKGROUND_TOKEN_BUDGET_THRESHOLDS: "0.5,0.8,0.9,1.0",
      })
    ).toEqual([0.5, 0.8, 0.9, 1.0]);
    expect(
      parseDailyBackgroundTokenBudgetThresholds({
        THEBE_BACKGROUND_TOKEN_BUDGET_THRESHOLDS: "50,80,90,100",
      })
    ).toEqual([0.5, 0.8, 0.9, 1.0]);
    expect(
      parseDailyBackgroundTokenBudgetThresholds({
        THEBE_BACKGROUND_TOKEN_BUDGET_THRESHOLDS: " 90, 50 , 80 ",
      })
    ).toEqual([0.5, 0.8, 0.9]);
  });
});
