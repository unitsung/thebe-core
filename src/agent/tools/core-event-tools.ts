import { CORE_EVENT_TOOLS, DIAGNOSE_FROM_EVENTS_TOOL, LIST_CORE_EVENTS_TOOL } from "../extensions/mcp.ts";
import type { CustomToolDefinition, NormalizedEvent } from "../runtime/interface.ts";

export function createCoreEventTools(read: (sessionId?: string) => readonly NormalizedEvent[]): CustomToolDefinition[] {
  return Object.entries(CORE_EVENT_TOOLS).map(([name, metadata]) => ({
    name, label: name, description: metadata.description, parameters: metadata.schema,
    async execute(_id, input) {
      const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const events = read(typeof params.sessionId === "string" ? params.sessionId : undefined);
      let value: unknown;
      if (name === LIST_CORE_EVENTS_TOOL) {
        const limit = typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.min(500, Math.max(1, Math.floor(params.limit))) : 50;
        value = events.slice(-limit);
      } else if (name === DIAGNOSE_FROM_EVENTS_TOOL) {
        const errors = events.filter(event => event.type === "error" || event.type === "interrupted");
        value = { category: params.category ?? "all", totalEvents: events.length, errors: errors.length, lastError: errors.at(-1) ?? null };
      }
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
    },
  }));
}
