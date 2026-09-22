import type { ThebeHttpContext } from "../context.ts";
import { CONTAINER_TOOL_NAMES } from "../../../agent/capabilities/containers.ts";
import {
  DIAGNOSE_FROM_EVENTS_TOOL,
  LIST_CORE_EVENTS_TOOL,
  listCoreMcpTools,
} from "../../../agent/extensions/mcp.ts";
import { asObject, json, readJson } from "../json.ts";

const MCP_EVENT_TOOLS = [LIST_CORE_EVENTS_TOOL, DIAGNOSE_FROM_EVENTS_TOOL] as const;

const ALIASES: Record<string, (typeof CONTAINER_TOOL_NAMES)[number]> = {
  containers_summary: "container.status_summary",
  container_logs: "container.logs",
};

const ALL_TOOL_NAMES = new Set<string>([
  ...CONTAINER_TOOL_NAMES,
  ...MCP_EVENT_TOOLS,
  ...Object.keys(ALIASES),
]);

function listedCoreTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return listCoreMcpTools().map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

async function callTool(
  agent: NonNullable<ThebeHttpContext["agent"]> | undefined,
  name: string,
  args: unknown,
): Promise<string> {
  if ((MCP_EVENT_TOOLS as readonly string[]).includes(name)) {
    if (!agent) throw new Error("MCP tools require the Thebe agent service");
    return agent.invokeTool(name, asObject(args) ?? {});
  }
  const mapped = ALIASES[name] ?? name;
  if (ALL_TOOL_NAMES.has(name)) {
    if (!agent) {
      throw new Error("MCP tools require the Thebe agent service");
    }
    return agent.invokeTool(mapped, asObject(args) ?? {});
  }
  if (agent) {
    const coreCapability = (await agent.listMcpTools()).find((tool) => {
      return tool.source === "core" && (tool.id === mapped || tool.name === mapped);
    });
    if (coreCapability) {
      return agent.invokeTool(coreCapability.name, asObject(args) ?? {});
    }
  }
  if (agent && name.startsWith("mcp:")) {
    return agent.invokeTool(name, asObject(args) ?? {});
  }
  throw new Error(`unknown tool: ${name}`);
}

async function listedTools(
  agent?: NonNullable<ThebeHttpContext["agent"]>,
): Promise<Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}>> {
  if (!agent) return listedCoreTools();
  return (await agent.listMcpTools()).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

function mcpError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function handleMcp(
  context: ThebeHttpContext,
): Promise<Response> {
  const body = await readJson(context.request);
  const { agent } = context;
  const id = body.id ?? null;
  const method = typeof body.method === "string" ? body.method : "";
  if (method.startsWith("notifications/")) {
    return new Response(null, { status: 204 });
  }
  if (method === "ping") {
    return json({ jsonrpc: "2.0", id, result: {} });
  }
  if (method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
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
      503,
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
      const text = await callTool(agent, name, params.arguments);
      return json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }] },
      });
    } catch (error) {
      return mcpError(
        id,
        -32000,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return mcpError(id, -32601, "Method not found");
}
