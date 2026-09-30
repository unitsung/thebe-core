import type { McpRegistry, McpCallResult } from "../extensions/mcp.ts";
import type { CreateRuntimeSessionOptions } from "../runtime/interface.ts";
import { redactToolOutput } from "../security/redaction.ts";
import { wrapCustomTools } from "./wrapped-tool.ts";

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactToolOutput(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(password|token|secret|api_?key|credential)$/i.test(key) ? "***REDACTED***" : redactValue(item)]));
  }
  return value;
}

/** One adapter for any discovered MCP schema, with the same audit/budget boundary. */
export function createRuntimeMcpPort(registry: McpRegistry,
  options: Parameters<typeof wrapCustomTools>[1] & {
    policy: Parameters<typeof wrapCustomTools>[1]["policy"];
  }): NonNullable<CreateRuntimeSessionOptions["externalMcp"]> {
  const executors = new Map<string, ReturnType<typeof wrapCustomTools>[number]>();
  return {
    async listTools() {
      const tools = await registry.listTools();
      options.policy.registerTools(tools.map((tool) => tool.name));
      executors.clear();
      for (const tool of tools) {
        const [wrapped] = wrapCustomTools([{
          name: tool.name, label: tool.name, description: tool.description,
          parameters: tool.inputSchema,
          async execute(_id, args, signal) {
            if (!registry.invokeToolResult) throw new Error("MCP registry does not support structured calls");
            const result = redactValue(await registry.invokeToolResult(tool.name, args, signal)) as McpCallResult;
            return { content: [{ type: "text", text: JSON.stringify(result) }],
              details: { mcpResult: result }, isError: result.isError };
          },
        }], options);
        executors.set(tool.name, wrapped!);
      }
      return tools;
    },
    async callTool(name, args, signal) {
      const executor = executors.get(name);
      if (!executor) throw new Error(`MCP tool is not registered: ${name}`);
      const result = await executor.execute(crypto.randomUUID(), args, signal);
      return (result.details?.mcpResult as McpCallResult | undefined) ?? {
        content: result.content, isError: true,
      };
    },
  };
}
