import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONTAINER_TOOL_DESCRIPTIONS,
  CONTAINER_TOOL_NAMES,
  CONTAINER_TOOL_SCHEMAS,
} from "../../tools/container-tools.ts";

export type McpToolInfo = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: "core" | "external";
  serverName?: string;
};

export type McpServerConfig = {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  disabled?: boolean;
};

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
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

export async function listConfiguredMcpServers(options?: {
  cwd?: string;
  homeDir?: string;
}): Promise<McpServerConfig[]> {
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.homeDir ?? homedir();
  const configs = new Map<string, McpServerConfig>();
  const candidateFiles = [
    join(home, ".thebe", "mcp.json"),
    join(home, ".config", "mcp.json"),
    join(cwd, ".thebe", "mcp.json"),
    join(cwd, ".mcp.json"),
  ];

  for (const file of candidateFiles) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const servers = (parsed.mcpServers || parsed.servers || {}) as Record<
        string,
        unknown
      >;
      for (const [name, val] of Object.entries(servers)) {
        if (typeof val === "object" && val !== null) {
          const s = val as Record<string, unknown>;
          const config: McpServerConfig = {
            name,
            command: typeof s.command === "string" ? s.command : undefined,
            args: Array.isArray(s.args)
              ? s.args.filter((arg): arg is string => typeof arg === "string")
              : undefined,
            url: typeof s.url === "string" ? s.url : undefined,
            env: stringMap(s.env),
            headers: stringMap(s.headers),
            disabled: s.disabled === true,
          };
          // Project configuration intentionally overrides a same-named global
          // server, matching how skills and most MCP clients resolve scope.
          configs.set(name, config);
        }
      }
    } catch {}
  }

  return [...configs.values()];
}
