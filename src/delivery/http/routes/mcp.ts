import type { ThebeHttpContext } from "../context.ts";
import { CONTAINER_TOOL_NAMES } from "../../../agent/capabilities/containers.ts";
import {
  DIAGNOSE_FROM_EVENTS_TOOL,
  LIST_CORE_EVENTS_TOOL,
  listCoreMcpTools,
  mcpToolVisibleTo,
  toMcpWireTool,
  type McpWireTool,
} from "../../../agent/extensions/mcp.ts";
import { parseCapabilityResult } from "../../../agent/capabilities/invoke.ts";
import type { McpCaller } from "../../../agent/index.ts";
import { asObject, json, readJson } from "../json.ts";
import {
  classifyMcpRequest,
  MCP_ERROR,
  META_SERVER_INFO,
  modernResult,
  negotiateLegacyVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  type McpRejection,
} from "./mcp-protocol.ts";
import {
  tokenMayDeleteIrreversibly,
  tokenMayWrite,
  type TokenCaller,
} from "../token-store.ts";

/** What the write gate needs to know about the token behind this call. */
export function toMcpCaller(caller: TokenCaller | undefined): McpCaller {
  return {
    name: caller?.name ?? "unknown",
    writes: tokenMayWrite(caller),
    irreversible: tokenMayDeleteIrreversibly(caller),
    ...(caller?.scopes && { scopes: caller.scopes }),
    ...(caller?.categories && { categories: caller.categories }),
  };
}

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

/**
 * Freshness hints for the newest protocol version. Tools change only when an operator connects or
 * removes a service, so a minute is long enough to save a round trip and short enough to follow
 * that. The list is `private`: a later token may be shown fewer tools than another, and a cache
 * must never hand one token's list to another.
 */
const TOOLS_LIST_TTL_MS = 60_000;
/** What `server/discover` says (versions, capabilities) changes only with a Core release. */
const DISCOVER_TTL_MS = 300_000;

const AGENT_REQUIRED = "MCP tools require the Thebe agent service";

async function callTool(
  agent: NonNullable<ThebeHttpContext["agent"]> | undefined,
  name: string,
  args: unknown,
  caller: McpCaller
): Promise<{ text: string; isError: boolean }> {
  if ((MCP_EVENT_TOOLS as readonly string[]).includes(name)) {
    if (!agent) throw new McpProtocolError(AGENT_REQUIRED, -32000);
    return agent.invokeMcpTool(name, asObject(args) ?? {}, caller);
  }
  const mapped = ALIASES[name] ?? name;
  if (ALL_TOOL_NAMES.has(name)) {
    if (!agent) throw new McpProtocolError(AGENT_REQUIRED, -32000);
    return agent.invokeMcpTool(mapped, asObject(args) ?? {}, caller);
  }
  if (agent) {
    const coreCapability = (await agent.listMcpTools()).find((tool) => {
      return (
        tool.source === "core" && (tool.id === mapped || tool.name === mapped)
      );
    });
    if (coreCapability) {
      return agent.invokeMcpTool(
        coreCapability.name,
        asObject(args) ?? {},
        caller
      );
    }
  }
  if (agent && name.startsWith("mcp:")) {
    return agent.invokeMcpTool(name, asObject(args) ?? {}, caller);
  }
  throw new McpProtocolError(`unknown tool: ${name}`, -32602);
}

/** Sorted by name so the list is the same on every request until the tools change. */
async function listedTools(
  agent: NonNullable<ThebeHttpContext["agent"]> | undefined,
  caller: McpCaller
): Promise<McpWireTool[]> {
  const capabilities = agent ? await agent.listMcpTools() : listCoreMcpTools();
  return capabilities
    .filter((capability) => mcpToolVisibleTo(capability, caller))
    .map(toMcpWireTool)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

function mcpError(
  id: unknown,
  code: number,
  message: string,
  status = 200,
  data?: unknown
): Response {
  return json(
    {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined && { data }) },
    },
    status
  );
}

function rejectRequest(id: unknown, rejection: McpRejection): Response {
  return mcpError(
    id,
    rejection.code,
    rejection.message,
    rejection.status,
    rejection.data
  );
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
  const era = classifyMcpRequest(context.request, body, method);
  if (era.kind === "rejected") return rejectRequest(id, era.rejection);
  const modern = era.kind === "modern";
  /** Older versions get the bare result they always got; the newest also says it is complete. */
  const reply = (result: Record<string, unknown>): Response =>
    json({
      jsonrpc: "2.0",
      id,
      result: modern ? modernResult(result, context.version) : result,
    });

  if (method === "ping") return reply({});
  if (method === "initialize") {
    return reply({
      protocolVersion: negotiateLegacyVersion(asObject(body.params)),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "thebe-core", version: context.version },
    });
  }
  if (modern && method === "server/discover") {
    return reply({
      supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      _meta: {
        [META_SERVER_INFO]: { name: "thebe-core", version: context.version },
      },
      ttlMs: DISCOVER_TTL_MS,
      cacheScope: "public",
    });
  }
  if (method === "tools/call" && agent?.isQuiesced()) {
    return mcpError(
      id,
      -32003,
      "System is quiesced for maintenance; write operations are temporarily disabled",
      503
    );
  }
  if (method === "tools/list") {
    const tools = await listedTools(agent, toMcpCaller(context.caller));
    return reply(
      modern
        ? { tools, ttlMs: TOOLS_LIST_TTL_MS, cacheScope: "private" }
        : { tools }
    );
  }
  if (method === "tools/call") {
    const params = asObject(body.params);
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) {
      return mcpError(
        id,
        MCP_ERROR.invalidParams,
        "tools/call requires params.name"
      );
    }
    try {
      const { text, isError } = await callTool(
        agent,
        name,
        params.arguments,
        toMcpCaller(context.caller)
      );
      return reply(toolResult(text, isError));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof McpProtocolError)
        return mcpError(id, error.code, message);
      // The model can read and recover from a tool failure only when it is a result, not a protocol error.
      return reply(toolResult(message, true));
    }
  }
  // The newest transport tells an unknown method apart from a missing endpoint with a 404.
  return mcpError(
    id,
    MCP_ERROR.methodNotFound,
    "Method not found",
    modern ? 404 : 200
  );
}
