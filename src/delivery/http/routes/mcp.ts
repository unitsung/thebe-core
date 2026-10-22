import type { ThebeHttpContext } from "../context.ts";
import { CONTAINER_TOOL_NAMES } from "../../../agent/capabilities/containers.ts";
import {
  DIAGNOSE_FROM_EVENTS_TOOL,
  LIST_CORE_EVENTS_TOOL,
  listCoreMcpTools,
  toMcpWireTool,
  type McpWireTool,
} from "../../../agent/extensions/mcp.ts";
import { parseCapabilityResult } from "../../../agent/capabilities/invoke.ts";
import { asObject, json, readJson } from "../json.ts";

const MCP_EVENT_TOOLS = [
  LIST_CORE_EVENTS_TOOL,
  DIAGNOSE_FROM_EVENTS_TOOL,
] as const;

const ALIASES: Record<string, (typeof CONTAINER_TOOL_NAMES)[number]> = {
  containers_summary: "container.status_summary",
  container_logs: "container.logs",
};

const ALL_TOOL_NAMES = new Set<string>([
  ...CONTAINER_TOOL_NAMES,
  ...MCP_EVENT_TOOLS,
  ...Object.keys(ALIASES),
]);

/**
 * Failures of the request itself (no such tool, no agent service) are JSON-RPC errors; a tool that
 * ran and failed, or rejected its input, is an `isError` result so the model can read and recover.
 */
class McpProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
  }
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;

/** The client's version when this server speaks it; otherwise the newest one it does. */
function negotiateProtocolVersion(params: Record<string, unknown>): string {
  const requested = params.protocolVersion;
  return (
    SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ??
    SUPPORTED_PROTOCOL_VERSIONS[0]
  );
}

const AGENT_REQUIRED = "MCP tools require the Thebe agent service";

async function callTool(
  agent: NonNullable<ThebeHttpContext["agent"]> | undefined,
  name: string,
  args: unknown
): Promise<{ text: string; isError: boolean }> {
  if ((MCP_EVENT_TOOLS as readonly string[]).includes(name)) {
    if (!agent) throw new McpProtocolError(AGENT_REQUIRED, -32000);
    return agent.invokeMcpTool(name, asObject(args) ?? {});
  }
  const mapped = ALIASES[name] ?? name;
  if (ALL_TOOL_NAMES.has(name)) {
    if (!agent) throw new McpProtocolError(AGENT_REQUIRED, -32000);
    return agent.invokeMcpTool(mapped, asObject(args) ?? {});
  }
  if (agent) {
    const coreCapability = (await agent.listMcpTools()).find((tool) => {
      return (
        tool.source === "core" && (tool.id === mapped || tool.name === mapped)
      );
    });
    if (coreCapability) {
      return agent.invokeMcpTool(coreCapability.name, asObject(args) ?? {});
    }
  }
  if (agent && name.startsWith("mcp:")) {
    return agent.invokeMcpTool(name, asObject(args) ?? {});
  }
  throw new McpProtocolError(`unknown tool: ${name}`, -32602);
}

async function listedTools(
  agent?: NonNullable<ThebeHttpContext["agent"]>
): Promise<McpWireTool[]> {
  const capabilities = agent ? await agent.listMcpTools() : listCoreMcpTools();
  return capabilities.map(toMcpWireTool);
}

/**
 * Text stays the universal fallback; a JSON object result is also offered as `structuredContent`
 * so clients can read typed data without re-parsing the text.
 */
function toolResult(text: string, isError = false): Record<string, unknown> {
  const result: Record<string, unknown> = { content: [{ type: "text", text }] };
  if (isError) {
    result.isError = true;
    return result;
  }
  const parsed = parseCapabilityResult(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    result.structuredContent = parsed;
  }
  return result;
}

function mcpError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function handleMcp(context: ThebeHttpContext): Promise<Response> {
  const body = await readJson(context.request);
  const { agent } = context;
  const id = body.id ?? null;
  const method = typeof body.method === "string" ? body.method : "";
  // A notification, or a client's reply to a server request, gets no JSON-RPC response: 202 Accepted.
  if (
    method.startsWith("notifications/") ||
    (!method && ("result" in body || "error" in body))
  ) {
    return new Response(null, { status: 202 });
  }
  if (method === "ping") {
    return json({ jsonrpc: "2.0", id, result: {} });
  }
  if (method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiateProtocolVersion(asObject(body.params)),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "thebe-core", version: context.version },
      },
    });
  }
  if (method === "tools/call" && agent?.isQuiesced()) {
    return json(
      {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32003,
          message:
            "System is quiesced for maintenance; write operations are temporarily disabled",
        },
      },
      503
    );
  }
  if (method === "tools/list") {
    return json({
      jsonrpc: "2.0",
      id,
      result: { tools: await listedTools(agent) },
    });
  }
  if (method === "tools/call") {
    const params = asObject(body.params);
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) return mcpError(id, -32602, "tools/call requires params.name");
    try {
      const { text, isError } = await callTool(agent, name, params.arguments);
      return json({ jsonrpc: "2.0", id, result: toolResult(text, isError) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof McpProtocolError)
        return mcpError(id, error.code, message);
      // The model can read and recover from a tool failure only when it is a result, not a protocol error.
      return json({ jsonrpc: "2.0", id, result: toolResult(message, true) });
    }
  }
  return mcpError(id, -32601, "Method not found");
}
