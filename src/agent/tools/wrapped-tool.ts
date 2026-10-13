import { hashParameters } from "../security/audit/audit-log.ts";
import type { createAuditLog } from "../security/audit/audit-log.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";
import { REDACTED, redactToolOutput } from "../security/redaction.ts";
import { limitModelOutput } from "./model-output-limit.ts";
import type {
  CustomToolDefinition,
  CustomToolResult,
  NormalizedEvent,
} from "../runtime/index.ts";

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
    sessionId?: () => string | undefined;
    /** Cap on the text one result adds to the model's context. Omit for callers that need the full result. */
    modelResultLimit?: number;
  }
): CustomToolDefinition[] {
  const limit = options.modelResultLimit;
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, params, signal) => {
      const started = Date.now();
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
          sessionId: options.sessionId?.(),
          result: "denied",
          durationMs: Date.now() - started,
        });
        if (await options.policy.shouldStopAfterTurn()) {
          await options.onStop?.();
        }
        return wrapResult(tool.name, limit, {
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
                new Error(
                  `tool call exceeded watchdog timeout (${watchdogMs}ms)`
                )
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
        const wrapped = wrapResult(tool.name, limit, result);
        const text = wrapped.content.map((block) => block.text).join("\n");
        await options.audit?.append({
          method: tool.name,
          parameterHash: hashParameters(params),
          responseBytes: Buffer.byteLength(text),
          budgetConsumed: 0,
          redactionFired: text.includes(REDACTED),
          sessionId: options.sessionId?.(),
          result: wrapped.isError ? "error" : "ok",
          durationMs: Date.now() - started,
        });
        return wrapped;
      } catch (error) {
        const message = redactToolOutput(
          error instanceof Error ? error.message : String(error)
        );
        await options.audit?.append({
          method: tool.name,
          parameterHash: hashParameters(params),
          responseBytes: 0,
          budgetConsumed: 0,
          redactionFired: message.includes(REDACTED),
          sessionId: options.sessionId?.(),
          result: "error",
          durationMs: Date.now() - started,
        });
        return wrapResult(tool.name, limit, {
          isError: true,
          content: [{ type: "text", text: message }],
          details: timedOut ? { watchdogTimeout: true } : {},
        });
      }
    },
  }));
}

function wrapResult(
  toolName: string,
  limit: number | undefined,
  result: CustomToolResult
): CustomToolResult {
  return {
    isError: result.isError,
    details: result.details ?? {},
    content: result.content.map((block) => ({
      type: "text" as const,
      text: `<tool_output tool="${toolName}">\n${limit === undefined ? redactToolOutput(block.text) : limitModelOutput(redactToolOutput(block.text), limit)}\n</tool_output>`,
    })),
  };
}
