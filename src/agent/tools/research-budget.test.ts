import { describe, expect, it } from "vitest";
import { createResearchBudget, RESEARCH_LIMITS } from "./research-budget.ts";

describe("research budget", () => {
  it("lets the allowed number of different web searches run and skips the next", () => {
    const budget = createResearchBudget(() => 0);
    for (let i = 0; i < RESEARCH_LIMITS.webSearch; i++) expect(budget.admit("web_search", `q${i}`)).toBeUndefined();
    expect(budget.admit("web_search", "one-too-many")).toContain("budget");
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
    for (let i = 0; i < RESEARCH_LIMITS.webSearch; i++) expect(budget.admit("web_search", `w${i}`)).toBeUndefined();
    for (let i = 0; i < RESEARCH_LIMITS.total - RESEARCH_LIMITS.webSearch; i++) {
      expect(budget.admit("music_research", `m${i}`)).toBeUndefined();
    }
    expect(budget.admit("web_search", "e")).toContain("budget");
    expect(budget.admit("music_research", "f")).toContain("budget");
  });

  it("starts fresh for a question asked after the window", () => {
    let now = 0;
    const budget = createResearchBudget(() => now);
    for (let i = 0; i < RESEARCH_LIMITS.webSearch; i++) budget.admit("web_search", `q${i}`);
    expect(budget.admit("web_search", "d")).toBeDefined();
    now = RESEARCH_LIMITS.windowMs + 1;
    expect(budget.admit("web_search", "d")).toBeUndefined();
  });
});
