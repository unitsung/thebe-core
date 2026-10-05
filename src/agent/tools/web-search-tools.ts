import { WEB_SEARCH_DESCRIPTION, WEB_SEARCH_SCHEMA, type WebSearchProvider } from "../capabilities/web-search.ts";
import type { CustomToolDefinition } from "../runtime/interface.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";

export function createWebSearchTools(provider: WebSearchProvider, policy: ReturnType<typeof createPolicyEngine>, callerId: string, enabled: () => Promise<boolean>): CustomToolDefinition[] {
  return [{ name: "web_search", label: "Web search", description: WEB_SEARCH_DESCRIPTION, parameters: WEB_SEARCH_SCHEMA, async execute(_id, input) {
    if (!await enabled()) throw new Error("Web search is disabled for this session. Enable it in Thebe settings.");
    const decision = policy.allow("web_search", callerId);
    if (!decision.ok) throw new Error(decision.reason);
    const query = (input as Record<string, unknown> | null)?.query;
    if (typeof query !== "string" || !query.trim() || query.length > 500) throw new Error("query must contain 1–500 characters");
    const result = await provider.search(query.trim());
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
  } }];
}
