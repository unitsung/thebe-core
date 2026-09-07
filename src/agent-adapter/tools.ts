import type {
  AgentHarnessTool,
  AgentTool,
} from "@earendil-works/pi-agent-core";

export function toHarnessTool(
  tool: AgentTool,
): AgentHarnessTool<undefined> {
  return {
    ...tool,
    execute: async (
      toolCallId,
      params,
      onUpdate,
      _toolContext,
      _invocation,
      context,
    ) => {
      return tool.execute(
        toolCallId,
        params,
        context.abortSignal,
        (partial) => onUpdate(partial),
      );
    },
  };
}
