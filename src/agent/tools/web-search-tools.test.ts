import { expect, it, vi } from "vitest";
import { createWebSearchTools } from "./web-search-tools.ts";
import { createPolicyEngine } from "../security/policy/policy-engine.ts";

it("searches with the trimmed query", async () => {
  const search = vi.fn().mockResolvedValue({ results: [{ url: "https://example.org" }] });
  const policy = createPolicyEngine({ now: () => new Date(), allowedToolNames: ["web_search"] });
  const tool = createWebSearchTools({ search }, policy, "test")[0]!;
  await expect(tool.execute("1", { query: " topic " })).resolves.toMatchObject({ content: [{ type: "text" }] });
  expect(search).toHaveBeenCalledWith("topic");
});

it("rejects malformed queries and enforces tool policy", async () => {
  const search = vi.fn();
  const tool = createWebSearchTools({ search }, createPolicyEngine({ now: () => new Date(), allowedToolNames: ["web_search"] }), "test")[0]!;
  await expect(tool.execute("1", {})).rejects.toThrow("query");
  await expect(tool.execute("2", { query: "x".repeat(501) })).rejects.toThrow("query");
  const denied = createWebSearchTools({ search }, createPolicyEngine({ now: () => new Date(), allowedToolNames: [] }), "test")[0]!;
  await expect(denied.execute("3", { query: "topic" })).rejects.toThrow();
  expect(search).not.toHaveBeenCalled();
});

it("stops fetching after the answer's search budget and never repeats a query", async () => {
  const { createResearchBudget, RESEARCH_LIMITS } = await import("./research-budget.ts");
  const search = vi.fn().mockResolvedValue({ results: [] });
  const policy = createPolicyEngine({ now: () => new Date(), allowedToolNames: ["web_search"] });
  const tool = createWebSearchTools({ search }, policy, "test", createResearchBudget(() => 0))[0]!;
  const queries = Array.from({ length: RESEARCH_LIMITS.webSearch }, (_, i) => `q${i}`);
  for (const query of queries) await tool.execute(query, { query });
  const repeated = await tool.execute("r", { query: "Q0" });
  const over = await tool.execute("d", { query: "d" });
  expect(search).toHaveBeenCalledTimes(RESEARCH_LIMITS.webSearch);
  expect(JSON.stringify(repeated)).toContain("already searched");
  expect(JSON.stringify(over)).toContain("budget");
});
