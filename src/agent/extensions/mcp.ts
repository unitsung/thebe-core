import {
  CONTAINER_CAPABILITY_METADATA,
  CONTAINER_RESTART_ACTION_ID,
  CONTAINER_RESTART_SCHEMA,
  CONTAINER_TOOL_DESCRIPTIONS,
  CONTAINER_TOOL_NAMES,
  CONTAINER_TOOL_SCHEMAS,
} from "../capabilities/containers.ts";
import {
  MEDIA_READ_DESCRIPTIONS,
  MEDIA_READ_SCHEMAS,
  MEDIA_READ_TOOL_NAMES,
} from "../capabilities/media.ts";

export const HOMELAB_CAPABILITY_CATEGORIES = [
  "files",
  "media",
  "downloads",
  "containers",
  "automation",
  "diagnostics",
  "other",
] as const;

export type HomelabCapabilityCategory =
  (typeof HOMELAB_CAPABILITY_CATEGORIES)[number];

export type HomelabCapabilityPermission = "read" | "confirm" | "admin";

/**
 * Stable metadata shared by native UI, agent prompts, and external plugins.
 * The MCP tool name remains the invocation id for backwards compatibility.
 */
export type HomelabCapability = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category: HomelabCapabilityCategory;
  permission: HomelabCapabilityPermission;
  effect?: "read" | "write";
  risk?: "low" | "disruptive";
  approval?: "none" | "required";
  service?: string;
  source: "core" | "external";
  serverName?: string;
};

/** MCP-compatible alias retained for existing callers and clients. */
export type McpToolInfo = HomelabCapability;

export type McpServerInfo = {
  name: string;
  command?: string;
  url?: string;
  service?: string;
  category?: HomelabCapabilityCategory;
  permission?: HomelabCapabilityPermission;
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
    const meta = CONTAINER_CAPABILITY_METADATA[name];
    tools.push({
      id: name,
      name,
      description:
        CONTAINER_TOOL_DESCRIPTIONS[name] || `Core container tool ${name}`,
      inputSchema: CONTAINER_TOOL_SCHEMAS[name],
      category: "containers",
      permission: meta.permission,
      effect: meta.effect,
      risk: meta.risk,
      approval: meta.approval,
      service: "arcane",
      source: "core",
      serverName: "thebe-core",
    });
  }
  const restartMeta = CONTAINER_CAPABILITY_METADATA[CONTAINER_RESTART_ACTION_ID];
  tools.push({
    id: CONTAINER_RESTART_ACTION_ID,
    name: CONTAINER_RESTART_ACTION_ID,
    description: CONTAINER_TOOL_DESCRIPTIONS[CONTAINER_RESTART_ACTION_ID],
    inputSchema: CONTAINER_RESTART_SCHEMA,
    category: "containers",
    permission: restartMeta.permission,
    effect: restartMeta.effect,
    risk: restartMeta.risk,
    approval: restartMeta.approval,
    service: "arcane",
    source: "core",
    serverName: "thebe-core",
  });

  for (const [name, meta] of Object.entries(CORE_EVENT_TOOLS)) {
    tools.push({
      id: name,
      name,
      description: meta.description,
      inputSchema: meta.schema,
      category: "diagnostics",
      permission: "read",
      service: "thebe-core",
      source: "core",
      serverName: "thebe-core",
    });
  }

  for (const name of MEDIA_READ_TOOL_NAMES) {
    const service = name.startsWith("emby.")
      ? "emby"
      : name.startsWith("jellyfin.")
        ? "jellyfin"
        : "immich";
    tools.push({
      id: name,
      name,
      description: MEDIA_READ_DESCRIPTIONS[name],
      inputSchema: MEDIA_READ_SCHEMAS[name],
      category: "media",
      permission: "read",
      effect: "read",
      risk: "low",
      approval: "none",
      service,
      source: "core",
      serverName: "thebe-core",
    });
  }

  return tools;
}
