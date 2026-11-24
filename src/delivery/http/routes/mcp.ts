import type { ThebeHttpContext } from "../context.ts";
import { CONTAINER_TOOL_NAMES } from "../../../agent/capabilities/containers.ts";
import {
  DIAGNOSE_FROM_EVENTS_TOOL,
  LIST_CORE_EVENTS_TOOL,
  capabilityChangesThings,
  listCoreMcpTools,
  toMcpWireTool,
  type McpWireTool,
} from "../../../agent/extensions/mcp.ts";
import { parseCapabilityResult } from "../../../agent/capabilities/invoke.ts";
import type { McpCaller } from "../../../agent/index.ts";
import { asObject, json, readJson } from "../json.ts";
import { tokenMayDeleteIrreversibly, tokenMayWrite } from "../token-store.ts";

const MCP_EVENT_TOOLS = [
  LIST_CORE_EVENTS_TOOL,
  DIAGNOSE_FROM_EVENTS_TOOL,
] as const;

const ALIASES: Record<string, (typeof CONTAINER_TOOL_NAMES)[number]> = {
  containers_summary: "container_status_summary",
  container_logs: "container_logs",
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

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
const SUPPORTED_PROTOCOL_VERSIONS = [
  MODERN_PROTOCOL_VERSION,
  ...LEGACY_PROTOCOL_VERSIONS,
] as const;
const DEFAULT_LEGACY_PROTOCOL_VERSION = "2025-06-18";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const MODERN_CACHE_TTL_MS = 30_000;
const NAMED_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

function isLegacyProtocolVersion(version: string): boolean {
  return (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

function isSupportedProtocolVersion(version: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/**
 * The client's version when this server speaks it; otherwise the version older clients expect.
 * A legacy `initialize` keeps answering 2025-06-18 by default so existing clients see no change.
 */
function negotiateProtocolVersion(params: Record<string, unknown>): string {
  const requested = params.protocolVersion;
  return typeof requested === "string" && isLegacyProtocolVersion(requested)
    ? requested
    : DEFAULT_LEGACY_PROTOCOL_VERSION;
}

function serverInfo(version: string): Record<string, unknown> {
  return { name: "thebe-core", version };
}

function modernResult(
  result: Record<string, unknown>,
  version: string
): Record<string, unknown> {
  return {
    resultType: "complete",
    ...result,
    _meta: {
      ...asObject(result._meta),
      [SERVER_INFO_META]: serverInfo(version),
    },
  };
}

function isModernRequest(
  request: Request,
  params: Record<string, unknown>,
  method: string
): boolean {
  if (method === "initialize") return false;
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion && !isLegacyProtocolVersion(headerVersion)) return true;
  const meta = asObject(params._meta);
  return typeof meta[PROTOCOL_VERSION_META] === "string";
}

function validateModernRequest(
  context: ThebeHttpContext,
  id: unknown,
  method: string,
  params: Record<string, unknown>
): Response | undefined {
  const headers = context.request.headers;
  const headerVersion = headers.get("mcp-protocol-version")?.trim();
  const meta = asObject(params._meta);
  const bodyVersionRaw = meta[PROTOCOL_VERSION_META];
  const bodyVersion =
    typeof bodyVersionRaw === "string" ? bodyVersionRaw : undefined;

  if (!headerVersion) {
    return mcpError(
      id,
      -32020,
      "Header mismatch: MCP-Protocol-Version header is required",
      400
    );
  }
  if (bodyVersion && bodyVersion !== headerVersion) {
    return mcpError(
      id,
      -32020,
      `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match _meta value '${bodyVersion}'`,
      400
    );
  }
  if (!isSupportedProtocolVersion(headerVersion)) {
    return mcpError(id, -32022, "Unsupported protocol version", 400, {
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      requested: headerVersion,
    });
  }
  if (!bodyVersion && method !== "server/discover") {
    return mcpError(
      id,
      -32602,
      `params._meta.${PROTOCOL_VERSION_META} is required`,
      400
    );
  }

  const headerMethod = headers.get("mcp-method")?.trim();
  if (!headerMethod) {
    return mcpError(
      id,
      -32020,
      "Header mismatch: Mcp-Method header is required",
      400
    );
  }
  if (headerMethod !== method) {
    return mcpError(
      id,
      -32020,
      `Header mismatch: Mcp-Method header value '${headerMethod}' does not match method '${method}'`,
      400
    );
  }

  if (NAMED_METHODS.has(method)) {
    const value = method === "resources/read" ? params.uri : params.name;
    const expected = typeof value === "string" ? value : "";
    const headerName = headers.get("mcp-name");
    if (!headerName) {
      return mcpError(
        id,
        -32020,
        `Header mismatch: Mcp-Name header is required for ${method}`,
        400
      );
    }
    if (decodeHeaderValue(headerName) !== expected) {
      return mcpError(
        id,
        -32020,
        `Header mismatch: Mcp-Name header value '${headerName}' does not match body value '${expected}'`,
        400
      );
    }
  }

  if (method !== "server/discover") {
    const capabilities = meta[CLIENT_CAPABILITIES_META];
    if (
      !capabilities ||
      typeof capabilities !== "object" ||
      Array.isArray(capabilities)
    ) {
      return mcpError(
        id,
        -32602,
        `params._meta.${CLIENT_CAPABILITIES_META} is required`,
        400
      );
    }
  }

  return undefined;
}

function decodeHeaderValue(value: string): string | undefined {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice(9, -2);
  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function sortTools(tools: McpWireTool[]): McpWireTool[] {
  return [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
}

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

/**
 * A token that may not write is not shown the write tools, so its agent does not plan around calls
 * that would be refused. The deletes that cannot be undone stay listed: they are judged per call.
 */
async function listedTools(
  agent: NonNullable<ThebeHttpContext["agent"]> | undefined,
  mayWrite: boolean
): Promise<McpWireTool[]> {
  const capabilities = agent ? await agent.listMcpTools() : listCoreMcpTools();
  return capabilities
    .map(toMcpWireTool)
    .filter((tool) => mayWrite || tool.annotations.readOnlyHint);
}

async function isReadOnlyTool(
  agent: NonNullable<ThebeHttpContext["agent"]> | undefined,
  name: string
): Promise<boolean> {
  const mapped = ALIASES[name] ?? name;
  const tools = agent ? await agent.listMcpTools() : listCoreMcpTools();
  const tool = tools.find(
    (item) =>
      item.name === mapped ||
      item.id === mapped ||
      (mapped.startsWith("mcp:") && item.name === mapped)
  );
  return Boolean(tool && !capabilityChangesThings(tool));
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
  data?: Record<string, unknown>
): Response {
  return json(
    {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data ? { data } : {}) },
    },
    status
  );
}

export async function handleMcp(context: ThebeHttpContext): Promise<Response> {
  const body = await readJson(context.request);
  const { agent } = context;
  const id = body.id ?? null;
  const method = typeof body.method === "string" ? body.method : "";
  const params = asObject(body.params);
  // A notification, or a client's reply to a server request, gets no JSON-RPC response: 202 Accepted.
  if (
    method.startsWith("notifications/") ||
    (!method && ("result" in body || "error" in body))
  ) {
    return new Response(null, { status: 202 });
  }
  const modern = isModernRequest(context.request, params, method);
  if (modern) {
    const error = validateModernRequest(context, id, method, params);
    if (error) return error;
  }
  if (method === "ping") {
    return json({
      jsonrpc: "2.0",
      id,
      result: modern ? modernResult({}, context.version) : {},
    });
  }
  if (method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiateProtocolVersion(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: serverInfo(context.version),
      },
    });
  }
  if (method === "server/discover") {
    if (!modern) return mcpError(id, -32601, "Method not found");
    return json({
      jsonrpc: "2.0",
      id,
      result: modernResult(
        {
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: { tools: { listChanged: false } },
          ttlMs: MODERN_CACHE_TTL_MS,
          cacheScope: "public",
        },
        context.version
      ),
    });
  }
  if (method === "tools/list") {
    const tools = await listedTools(agent, tokenMayWrite(context.caller));
    return json({
      jsonrpc: "2.0",
      id,
      result: modern
        ? modernResult(
            {
              tools: sortTools(tools),
              ttlMs: MODERN_CACHE_TTL_MS,
              cacheScope: "private",
            },
            context.version
          )
        : { tools },
    });
  }
  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) return mcpError(id, -32602, "tools/call requires params.name");
    if (agent?.isQuiesced() && !(await isReadOnlyTool(agent, name))) {
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
    try {
      const { text, isError } = await callTool(agent, name, params.arguments, {
        name: context.caller?.name,
        writes: tokenMayWrite(context.caller),
        irreversible: tokenMayDeleteIrreversibly(context.caller),
      });
      const result = toolResult(text, isError);
      return json({
        jsonrpc: "2.0",
        id,
        result: modern ? modernResult(result, context.version) : result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof McpProtocolError)
        return mcpError(id, error.code, message);
      // The model can read and recover from a tool failure only when it is a result, not a protocol error.
      const result = toolResult(message, true);
      return json({
        jsonrpc: "2.0",
        id,
        result: modern ? modernResult(result, context.version) : result,
      });
    }
  }
  return mcpError(id, -32601, "Method not found", modern ? 404 : 200);
}
