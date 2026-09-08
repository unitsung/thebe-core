import { hashParameters } from "../audit/audit-log.ts";
import type { createAuditLog } from "../audit/audit-log.ts";
import type { createPolicyEngine } from "../policy/policy-engine.ts";
import { REDACTED, redactToolOutput } from "../tools/redaction.ts";
import type { CustomToolDefinition, CustomToolResult, NormalizedEvent } from "../runtime/types.ts";

type Policy = ReturnType<typeof createPolicyEngine>;
type Audit = ReturnType<typeof createAuditLog>;

export function wrapCustomTools(
  tools: CustomToolDefinition[],
  options: {
    policy: Policy;
    audit?: Audit;
    toolWatchdogMs?: number;
    onEvent?: (event: NormalizedEvent) => void;
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
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      const watchdogMs = options.toolWatchdogMs;
      const executePromise = tool.execute(toolCallId, params, signal);
      try {
        let result: CustomToolResult;
        if (watchdogMs && watchdogMs > 0) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              options.onEvent?.({
                type: "tool_watchdog_timeout",
                toolCallId,
                toolName: tool.name,
                elapsedMs: watchdogMs,
              });
              reject(
                new Error(`tool call exceeded watchdog timeout (${watchdogMs}ms)`),
              );
            }, watchdogMs);
          });
          try {
            result = await Promise.race([executePromise, timeoutPromise]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        } else {
          result = await executePromise;
        }
        const wrapped = wrapResult(tool.name, result);
        const text = wrapped.content.map((block) => block.text).join("\n");
        await options.audit?.append({
          method: tool.name,
          parameterHash: hashParameters(params),
          responseBytes: Buffer.byteLength(text),
          budgetConsumed: 0,
          redactionFired: text.includes(REDACTED),
        });
        return wrapped;
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
        if (signal?.aborted || timedOut) {
          return wrapResult(tool.name, {
            isError: true,
            content: [{ type: "text", text: message }],
            details: timedOut ? { watchdogTimeout: true } : {},
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

function wrapResult(toolName: string, result: CustomToolResult): CustomToolResult {
  return {
    isError: result.isError,
    details: result.details ?? {},
    content: result.content.map((block) => ({
      type: "text" as const,
      text: `<tool_output tool="${toolName}">\n${redactToolOutput(block.text)}\n</tool_output>`,
    })),
  };
}
