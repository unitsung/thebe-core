import { hashParameters } from "../security/audit/audit-log.ts";
import type { createAuditLog } from "../security/audit/audit-log.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";
import type { McpRegistry } from "../extensions/mcp.ts";
import type { NormalizedEvent, RuntimeMcpOptions } from "../runtime/interface.ts";

type Policy = ReturnType<typeof createPolicyEngine>;
type Audit = ReturnType<typeof createAuditLog>;

/** Pi names a server's tools `mcp__<server>__<tool>`, with `-` in the server name written as `_`. */
const serverPrefix = (name: string): string => `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}__`;

/**
 * What the runtime's own MCP client needs from Core: the configured servers and the policy and audit
 * boundary every call crosses. Core opens no MCP connection for a model call.
 */
export function createRuntimeMcpOptions(
  registry: McpRegistry,
  options: {
    policy: Policy;
    audit?: Audit;
    sessionId?: () => string | undefined;
    onEvent?: (event: NormalizedEvent) => void;
    onStop?: () => void | Promise<void>;
  },
): RuntimeMcpOptions | undefined {
  if (!registry.runtimeServers) return undefined;
  const runtimeServers = registry.runtimeServers.bind(registry);
  const owns = (toolName: string) =>
    runtimeServers().some((server) => toolName.startsWith(serverPrefix(server.name)));
  const record = (toolName: string, input: unknown, fields: Pick<Parameters<NonNullable<Audit>["append"]>[0], "responseBytes" | "redactionFired" | "result" | "durationMs">) =>
    options.audit?.append({
      method: toolName, parameterHash: hashParameters(input), budgetConsumed: 0,
      sessionId: options.sessionId?.(), ...fields,
    });
  return {
    servers: runtimeServers,
    async beforeCall(call) {
      // Resource tools (list/read) are not a server's own tools and only read.
      if (!owns(call.toolName)) return undefined;
      options.policy.registerTools([call.toolName]);
      const decision = await options.policy.beforeToolCall({ toolCall: { name: call.toolName } });
      if (!decision.block) return undefined;
      await record(call.toolName, call.input, {
        responseBytes: 0, redactionFired: false, result: "denied", durationMs: 0,
      });
      if (await options.policy.shouldStopAfterTurn()) await options.onStop?.();
      return { block: decision.reason ?? "denied" };
    },
    async afterCall(call, outcome) {
      await record(call.toolName, call.input, {
        responseBytes: outcome.bytes, redactionFired: outcome.redacted,
        result: outcome.isError ? "error" : "ok", durationMs: outcome.durationMs,
      });
    },
  };
}
