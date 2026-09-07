import { hashParameters } from "../audit/audit-log.ts";
import type { createAuditLog } from "../audit/audit-log.ts";
import type { createPolicyEngine } from "../policy/policy-engine.ts";
import { REDACTED, redactToolOutput } from "../tools/redaction.ts";
import type { CustomToolDefinition, CustomToolResult } from "../runtime/types.ts";

type Policy = ReturnType<typeof createPolicyEngine>;
type Audit = ReturnType<typeof createAuditLog>;

export function wrapCustomTools(
  tools: CustomToolDefinition[],
  options: {
    policy: Policy;
    audit?: Audit;
    onStop?: () => void | Promise<void>;
  },
): CustomToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, params, signal) => {
      const decision = await options.policy.beforeToolCall({
        toolCall: { name: tool.name },
      });
      if (decision.block) {
        await options.audit?.append({
          method: tool.name,
          parameterHash: hashParameters(params),
          responseBytes: 0,
          budgetConsumed: 0,
          redactionFired: false,
        });
        if (await options.policy.shouldStopAfterTurn()) {
          await options.onStop?.();
        }
        return redactResult({
          isError: true,
          content: [
            {
              type: "text",
              text: decision.reason ?? "denied",
            },
          ],
          details: {},
        });
      }
      try {
        const result = await tool.execute(toolCallId, params, signal);
        const redacted = redactResult(result);
        const text = redacted.content.map((block) => block.text).join("\n");
        await options.audit?.append({
          method: tool.name,
          parameterHash: hashParameters(params),
          responseBytes: Buffer.byteLength(text),
          budgetConsumed: 0,
          redactionFired: text.includes(REDACTED),
        });
        return redacted;
      } catch (error) {
        const message = redactToolOutput(
          error instanceof Error ? error.message : String(error),
        );
        await options.audit?.append({
          method: tool.name,
          parameterHash: hashParameters(params),
          responseBytes: 0,
          budgetConsumed: 0,
          redactionFired: message.includes(REDACTED),
        });
        if (signal?.aborted) {
          return redactResult({
            isError: true,
            content: [{ type: "text", text: message }],
            details: {},
          });
        }
        throw new Error(message);
      }
    },
  }));
}

function redactResult(result: CustomToolResult): CustomToolResult {
  return {
    isError: result.isError,
    details: result.details ?? {},
    content: result.content.map((block) => ({
      type: "text" as const,
      text: redactToolOutput(block.text),
    })),
  };
}
