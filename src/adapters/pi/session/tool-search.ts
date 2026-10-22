/**
 * Core's `tool_search`: Pi's search with a relevance floor.
 *
 * Pi ranks deferred tools with BM25 and loads every tool with a positive score, so a query for
 * something no tool does ("analyze image", "relaxing sleep sounds") still loads whatever shares a
 * word, and the model then calls it. This keeps Pi's ranking idea and its loading mechanism, but a
 * tool must match at least half of the query's terms, and be near the best match, to load at all.
 * With nothing left the answer says so, which lets the model answer in words.
 * Pi itself is untouched: this replaces only the extension Core registers.
 */

const DEFAULT_LIMIT = 8;
/** A tool must score at least this share of the best match. */
const RELATIVE_FLOOR = 0.4;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
  "any",
  "all",
  "my",
  "me",
  "i",
  "do",
  "does",
  "can",
  "you",
]);

function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term))
    return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss"))
    return term.slice(0, -1);
  return term;
}

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

export type SearchableTool = {
  name: string;
  description: string;
  namespace?: { name: string; description?: string };
};
export type ToolMatch = { name: string; score: number; matched: number };

/** BM25 over name, description and namespace, then the floor. Parameter text is left out on purpose. */
export function rankTools(
  query: string,
  tools: readonly SearchableTool[],
  limit: number
): ToolMatch[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || tools.length === 0 || limit <= 0) return [];
  const counts = tools.map((tool) => {
    const map = new Map<string, number>();
    const text = [
      tool.name,
      tool.name.replaceAll("_", " "),
      tool.description,
      tool.namespace?.name ?? "",
      tool.namespace?.description ?? "",
    ].join(" ");
    for (const term of tokenize(text)) map.set(term, (map.get(term) ?? 0) + 1);
    return map;
  });
  const lengths = counts.map((map) =>
    [...map.values()].reduce((sum, n) => sum + n, 0)
  );
  const average = lengths.reduce((sum, n) => sum + n, 0) / tools.length || 1;
  const idf = new Map(
    queryTerms.map((term) => {
      const frequency = counts.filter((map) => map.has(term)).length;
      return [
        term,
        Math.log(1 + (tools.length - frequency + 0.5) / (frequency + 0.5)),
      ] as const;
    })
  );
  const k1 = 1.2;
  const b = 0.75;
  const scored: ToolMatch[] = [];
  tools.forEach((tool, index) => {
    let score = 0;
    let matched = 0;
    for (const term of queryTerms) {
      const count = counts[index]!.get(term);
      if (!count) continue;
      matched += 1;
      const norm = k1 * (1 - b + (b * lengths[index]!) / average);
      score += (idf.get(term) ?? 0) * ((count * (k1 + 1)) / (count + norm));
    }
    if (score > 0) scored.push({ name: tool.name, score, matched });
  });
  scored.sort((a, b) => b.score - a.score);
  // Modifiers such as "recently added" match no tool, so a third of the terms is enough; a lone shared
  // word in a long query ("image" in "analyze image describe picture") is not.
  const needed = Math.max(1, Math.ceil(queryTerms.length / 3));
  const best = scored[0]?.score ?? 0;
  return scored
    .filter((m) => m.matched >= needed && m.score >= best * RELATIVE_FLOOR)
    .slice(0, limit);
}

type ToolsApi = {
  getActiveTools(): string[];
  getAllTools(): Array<SearchableTool & { exposure?: string }>;
  setActiveTools(names: string[]): void;
};

function isSearchable(exposure: string | undefined): boolean {
  return exposure === "codemode" || exposure === "deferred";
}

function searchAndLoad(api: ToolsApi, query: string, limit: number) {
  const active = api.getActiveTools();
  const candidates = api
    .getAllTools()
    .filter(
      (tool) => isSearchable(tool.exposure) && !active.includes(tool.name)
    );
  const matches = rankTools(query, candidates, limit);
  if (matches.length > 0)
    api.setActiveTools([...active, ...matches.map((m) => m.name)]);
  return matches.map((m) => ({
    name: m.name,
    description: candidates.find((t) => t.name === m.name)?.description ?? "",
  }));
}

const DESCRIPTION = `# Tool discovery

Searches deferred tools and makes the best matches available from your next call. Use short English keywords for what the task needs. A search that finds nothing means no tool fits: answer in words instead of searching again.

Some tools, such as those of MCP servers, are not provided upfront; use this tool (\`tool_search\`) to find the ones the task needs. Chat, advice, writing, translation and questions you can answer yourself need no tool.`;

/** The Pi extension factory: registers `tool_search` in place of Pi's own. */
export function createRelevantToolSearchExtension() {
  return (pi: ToolsApi & { registerTool(definition: unknown): unknown }) => {
    pi.registerTool({
      name: "tool_search",
      label: "tool_search",
      description: DESCRIPTION,
      promptSnippet:
        "Search for tools that are not loaded yet and load the matches",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Short English keywords for the tool the task needs.",
          },
          limit: {
            type: "number",
            description: `Maximum number of tools to return. Defaults to ${DEFAULT_LIMIT}.`,
          },
        },
        required: ["query"],
      },
      exposure: "model-only",
      reachesTools: () => "all",
      defaultActive: false,
      async execute(
        _id: string,
        { query, limit }: { query: string; limit?: number }
      ) {
        if (typeof query !== "string" || query.trim() === "")
          throw new Error("query must not be empty");
        const max = limit ?? DEFAULT_LIMIT;
        if (!Number.isInteger(max) || max <= 0)
          throw new Error("limit must be a positive integer");
        const loaded = searchAndLoad(pi, query, max);
        return {
          content: [
            {
              type: "text",
              text:
                loaded.length === 0
                  ? "No connected tool fits this search. If the user did not ask to act on a connected service, answer without tools."
                  : `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:\n${loaded
                      .map(
                        (t) =>
                          `- ${t.name}: ${t.description.trim().split(/\r?\n/)[0]}`
                      )
                      .join("\n")}`,
            },
          ],
          details: { loaded: loaded.map((t) => t.name) },
        };
      },
    });
  };
}
