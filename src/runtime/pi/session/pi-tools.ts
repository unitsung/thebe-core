import type { CustomToolDefinition } from "../../types.ts";
import { mapPiMessages } from "./map-events.ts";
import type { PiSdk } from "../sdk/load-pi.ts";
import type { PiSession } from "./pi-session.ts";

export function toPiTool(sdk: PiSdk, tool: CustomToolDefinition) {
  return sdk.defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as never,
    executionMode: "sequential",
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ) => {
      const result = await tool.execute(toolCallId, params, signal);
      return {
        content: result.content,
        details: result.details ?? {},
        isError: result.isError,
      };
    },
  });
}

export function lastAssistantText(session: PiSession): string {
  const mapped = mapPiMessages(session.messages);
  for (let i = mapped.length - 1; i >= 0; i--) {
    const message = mapped[i];
    if (message?.role === "assistant") {
      return message.text;
    }
  }
  return "";
}
