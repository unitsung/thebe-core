import { MUSIC_RESEARCH_DESCRIPTION, MUSIC_RESEARCH_SCHEMA, type MusicResearchProvider } from "../capabilities/music-research.ts";
import type { CustomToolDefinition } from "../runtime/interface.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";
export function createMusicResearchTools(provider: MusicResearchProvider, policy: ReturnType<typeof createPolicyEngine>, callerId: string): CustomToolDefinition[] {
  return [{ name: "music_research", label: "Research music", description: MUSIC_RESEARCH_DESCRIPTION, parameters: MUSIC_RESEARCH_SCHEMA, async execute(_id, input) {
    const decision = policy.allow("music_research", callerId);
    if (!decision.ok) throw new Error(decision.reason);
    const args = input as Record<string, unknown> | null;
    if (!args || typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) throw new Error("query must contain 1–500 characters");
    if (args.entity !== undefined && !["recording", "artist", "release"].includes(String(args.entity))) throw new Error("invalid entity");
    if (args.language !== undefined && !["zh", "en"].includes(String(args.language))) throw new Error("invalid language");
    const result = await provider.research({ query: args.query.trim(), entity: args.entity as "recording" | "artist" | "release" | undefined, language: args.language as "zh" | "en" | undefined });
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
  } }];
}
