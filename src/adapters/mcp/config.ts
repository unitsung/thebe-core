import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

export async function listConfiguredMcpServers(options?: {
  cwd?: string;
  homeDir?: string;
}): Promise<McpServerConfig[]> {
  const cwd = options && "cwd" in options ? options.cwd : process.cwd();
  const home = options?.homeDir ?? homedir();
  const configs = new Map<string, McpServerConfig>();
  const candidateFiles = [
    join(home, ".thebe", "mcp.json"),
    join(home, ".config", "mcp.json"),
    ...(cwd ? [join(cwd, ".thebe", "mcp.json"), join(cwd, ".mcp.json")] : []),
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
    } catch {
      // Missing or malformed optional config files do not block startup.
    }
  }

  return [...configs.values()];
}
