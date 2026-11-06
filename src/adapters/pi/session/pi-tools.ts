import type { CustomToolDefinition } from "../../../agent/runtime/interface.ts";
import { mapPiMessages } from "./map-events.ts";
import type { PiSdk } from "../sdk/load-pi.ts";
import type { PiSession } from "./pi-session.ts";

/** `wireName` is what the model sees; Core's own name for the tool stays what it was. */
export function toPiTool(
  sdk: PiSdk,
  tool: CustomToolDefinition,
  wireName: string = tool.name
) {
  return sdk.defineTool({
    name: wireName,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as never,
    executionMode: "sequential",
    exposure: tool.exposure ?? "deferred",
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal
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
