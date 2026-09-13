import {
  CONTAINER_TOOL_DESCRIPTIONS,
  CONTAINER_TOOL_NAMES,
  CONTAINER_TOOL_SCHEMAS,
} from "../capabilities/containers.ts";

export type McpToolInfo = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: "core" | "external";
  serverName?: string;
};

export type McpServerInfo = {
  name: string;
  command?: string;
  url?: string;
  status?: string;
  error?: string;
  toolCount?: number;
  disabled?: boolean;
};

/** Agent-facing MCP capability port. Implementations belong to integrations. */
export type McpRegistry = {
  listTools(): Promise<McpToolInfo[]>;
  listServers(): Promise<McpServerInfo[]>;
  invokeTool(name: string, args: unknown): Promise<string | undefined>;
  close(): void;
};

export function createEmptyMcpRegistry(): McpRegistry {
  return {
    async listTools(): Promise<McpToolInfo[]> { return []; },
    async listServers(): Promise<McpServerInfo[]> { return []; },
    async invokeTool(): Promise<string | undefined> { return undefined; },
    close(): void {},
  };
}

const CORE_EVENT_TOOLS: Record<
  string,
  { description: string; schema: Record<string, unknown> }
> = {
  list_core_events: {
    description: "List recent events from the core event log",
    schema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO timestamp cutoff" },
        limit: { type: "number", description: "Max events to return" },
        sessionId: { type: "string", description: "Filter by session ID" },
      },
    },
  },
  diagnose_from_events: {
    description: "Diagnose issues from recorded core events",
    schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Diagnostic category" },
      },
    },
  },
};

export function listCoreMcpTools(): McpToolInfo[] {
  const tools: McpToolInfo[] = [];

  for (const name of CONTAINER_TOOL_NAMES) {
    tools.push({
      name,
      description:
        CONTAINER_TOOL_DESCRIPTIONS[name] || `Core container tool ${name}`,
      inputSchema: CONTAINER_TOOL_SCHEMAS[name],
      source: "core",
      serverName: "thebe-core",
    });
  }

  for (const [name, meta] of Object.entries(CORE_EVENT_TOOLS)) {
    tools.push({
      name,
      description: meta.description,
      inputSchema: meta.schema,
      source: "core",
      serverName: "thebe-core",
    });
  }

  return tools;
}
