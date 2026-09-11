import type { ThebeProduct } from "../../product/service.ts";
import {
  CONTAINER_TOOL_DESCRIPTIONS,
  CONTAINER_TOOL_NAMES,
} from "../../tools/container-tools.ts";
import { asObject, json, readJson } from "../json.ts";

const MCP_EVENT_TOOLS = ["list_core_events", "diagnose_from_events"] as const;

const ALIASES: Record<string, (typeof CONTAINER_TOOL_NAMES)[number]> = {
  containers_summary: "container.status_summary",
  container_logs: "container.logs",
};

const ALL_TOOL_NAMES = new Set<string>([
  ...CONTAINER_TOOL_NAMES,
  ...MCP_EVENT_TOOLS,
  ...Object.keys(ALIASES),
]);

function listedTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const container = CONTAINER_TOOL_NAMES.map((name) => ({
    name,
    description: CONTAINER_TOOL_DESCRIPTIONS[name],
    inputSchema: { type: "object" },
  }));
  return [
    ...container,
    {
      name: "list_core_events",
      description: "List recent webhook events stored on Thebe Core.",
      inputSchema: { type: "object" },
    },
    {
      name: "diagnose_from_events",
      description: "Summarize the most likely issue from Thebe Core events.",
      inputSchema: { type: "object" },
    },
  ];
}

async function callTool(
  product: ThebeProduct | undefined,
  name: string,
  args: unknown,
): Promise<string> {
  if (!ALL_TOOL_NAMES.has(name)) {
    throw new Error(`unknown tool: ${name}`);
  }
  if ((MCP_EVENT_TOOLS as readonly string[]).includes(name)) {
    if (name === "list_core_events") {
      return JSON.stringify({ events: [] });
    }
    return JSON.stringify({ summary: "No recent Core events." });
  }
  const mapped = ALIASES[name] ?? name;
  if (!product) {
    throw new Error("MCP tools require the Thebe product service");
  }
  return product.invokeTool(mapped, asObject(args) ?? {});
}

export async function handleMcp(
  request: Request,
  product?: ThebeProduct,
): Promise<Response> {
  const body = await readJson(request);
  const id = body.id ?? 1;
  const method = body.method;
  if (method === "tools/call" && product?.isQuiesced()) {
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
      result: { tools: listedTools() },
    });
  }
  if (method === "tools/call") {
    const params = asObject(body.params);
    const name = typeof params.name === "string" ? params.name : "";
    try {
      const text = await callTool(product, name, params.arguments);
      return json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }] },
      });
    } catch (error) {
      return json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  });
}
