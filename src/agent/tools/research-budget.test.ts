import { describe, expect, it } from "vitest";
import { createResearchBudget, RESEARCH_LIMITS } from "./research-budget.ts";

describe("research budget", () => {
  it("lets three different web searches run and skips the fourth", () => {
    const budget = createResearchBudget(() => 0);
    for (const q of ["a", "b", "c"]) expect(budget.admit("web_search", q)).toBeUndefined();
    expect(budget.admit("web_search", "d")).toContain("budget");
  });

  it("refuses an identical query without spending budget, ignoring case and spacing", () => {
    const budget = createResearchBudget(() => 0);
    expect(budget.admit("web_search", "Tao  Album")).toBeUndefined();
    expect(budget.admit("web_search", "tao album")).toContain("already searched");
    expect(budget.admit("web_search", "x")).toBeUndefined();
    expect(budget.admit("web_search", "y")).toBeUndefined();
  });

  it("caps combined lookups", () => {
    const budget = createResearchBudget(() => 0);
    expect(budget.admit("web_search", "a")).toBeUndefined();
    expect(budget.admit("web_search", "b")).toBeUndefined();
    expect(budget.admit("music_research", "c")).toBeUndefined();
    expect(budget.admit("music_research", "d")).toBeUndefined();
    expect(budget.admit("web_search", "e")).toContain("budget");
    expect(budget.admit("music_research", "f")).toContain("budget");
  });

  it("starts fresh for a question asked after the window", () => {
    let now = 0;
    const budget = createResearchBudget(() => now);
    for (const q of ["a", "b", "c"]) budget.admit("web_search", q);
    expect(budget.admit("web_search", "d")).toBeDefined();
    now = RESEARCH_LIMITS.windowMs + 1;
    expect(budget.admit("web_search", "d")).toBeUndefined();
  });
});
