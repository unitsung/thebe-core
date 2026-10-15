/**
 * Caps web research per answer. Every result is resent on each later turn, so a model that keeps
 * "verifying" grows the input quadratically. A run has no turn boundary here, so lookups are
 * counted inside a short window: a new question a few minutes later starts fresh.
 */
export const RESEARCH_LIMITS = { webSearch: 8, musicResearch: 6, total: 12, windowMs: 3 * 60_000 } as const;

export type ResearchBudget = {
  /** Returns a note for the model when the lookup must be skipped, or undefined to run it. */
  admit(tool: "web_search" | "music_research", query: string): string | undefined;
};

export function createResearchBudget(now: () => number = Date.now): ResearchBudget {
  const calls: Array<{ tool: string; key: string; at: number }> = [];
  return {
    admit(tool, query) {
      const at = now();
      while (calls.length && at - calls[0]!.at > RESEARCH_LIMITS.windowMs) calls.shift();
      const normalized = query.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
      const key = `${tool}|${normalized}`;
      if (normalized && calls.some((call) => call.key === key)) {
        return "This exact query was already searched in this answer; its result is above. Do not repeat it.";
      }
      const used = calls.filter((call) => call.tool === tool).length;
      const limit = tool === "web_search" ? RESEARCH_LIMITS.webSearch : RESEARCH_LIMITS.musicResearch;
      if (used >= limit || calls.length >= RESEARCH_LIMITS.total) {
        return `Search budget for this answer is used up (${RESEARCH_LIMITS.total} lookups). Answer now from the evidence already gathered and the library data, and state clearly what could not be verified.`;
      }
      calls.push({ tool, key, at });
      return undefined;
    },
  };
}

export function skippedResearch(note: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ results: [], note }) }], details: {} };
}
