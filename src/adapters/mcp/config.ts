import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { HOMELAB_CAPABILITY_CATEGORIES } from "../../agent/extensions/mcp.ts";
import type {
  HomelabCapabilityCategory,
  HomelabCapabilityPermission,
  McpServerRegistration,
} from "../../agent/extensions/mcp.ts";

export function validateMcpRegistration(input: McpServerRegistration): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.name)) throw new Error("Invalid MCP server name");
  if (Boolean(input.url) === Boolean(input.command)) throw new Error("Provide either a URL or a command");
  if (input.url) {
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("MCP URL must use HTTP or HTTPS without embedded credentials");
    }
  }
  if (input.command !== undefined && !input.command.trim()) throw new Error("MCP command is empty");
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string"))) {
    throw new Error("MCP arguments must be strings");
  }
  for (const map of [input.env, input.headers]) {
    if (map !== undefined && (!map || typeof map !== "object" || Array.isArray(map) || Object.values(map).some((value) => typeof value !== "string"))) {
      throw new Error("MCP environment and headers must contain string values");
    }
  }
}

/** Persist a new disabled server while preserving unrelated configuration. */
export async function addConfiguredMcpServer(input: McpServerRegistration, options: { cwd?: string; homeDir?: string }): Promise<void> {
  validateMcpRegistration(input);
  if ((await listConfiguredMcpServers(options)).some((server) => server.name === input.name)) throw new Error("MCP server already exists");
  const root = await realpath(options.cwd ?? options.homeDir ?? homedir());
  const directory = join(root, ".thebe");
  await mkdir(directory, { recursive: true });
  if (relative(root, await realpath(directory)) !== ".thebe") throw new Error("MCP configuration must be inside its root directory");
  const path = join(directory, "mcp.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(path, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid MCP configuration");
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Invalid MCP configuration JSON");
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const servers = config.mcpServers ?? config.servers ?? {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Invalid MCP server configuration");
  const { name, ...connection } = input;
  config.mcpServers = { ...servers, [name]: { ...connection, disabled: true } };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** A removal the caller cannot perform, reported with an HTTP-style status. */
export class McpConfigurationConflict extends Error {
  readonly status = 409;
  readonly code = "mcp_server_not_removable";
}

/**
 * Removes a server from the file that registration writes. A server defined only
 * in another configuration file (global, `.mcp.json`) is not ours to edit and is
 * refused rather than silently left in place. Returns whether anything was removed.
 */
export async function removeConfiguredMcpServer(name: string, options: { cwd?: string; homeDir?: string }): Promise<boolean> {
  const root = await realpath(options.cwd ?? options.homeDir ?? homedir());
  const path = join(root, ".thebe", "mcp.json");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Invalid MCP configuration JSON");
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return failIfConfiguredElsewhere(name, options);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid MCP configuration");
  const key = (["mcpServers", "servers"] as const).find((candidate) => {
    const group = config[candidate];
    return group && typeof group === "object" && !Array.isArray(group) && Object.hasOwn(group, name);
  });
  if (!key) return failIfConfiguredElsewhere(name, options);
  const { [name]: _removed, ...rest } = config[key] as Record<string, unknown>;
  config[key] = rest;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return true;
}

async function failIfConfiguredElsewhere(name: string, options: { cwd?: string; homeDir?: string }): Promise<false> {
  if ((await listConfiguredMcpServers(options)).some((server) => server.name === name)) {
    throw new McpConfigurationConflict("MCP server is defined outside Thebe's configuration file and cannot be removed here");
  }
  return false;
}

export type McpServerConfig = {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  disabled?: boolean;
  service?: string;
  category?: HomelabCapabilityCategory;
  permission?: HomelabCapabilityPermission;
  /** Passed to the runtime's MCP client: how the model reaches this server's tools. */
  exposure?: McpExposure;
  description?: string;
};

export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
const EXPOSURES: readonly string[] = ["codemode", "deferred", "direct", "hidden"];

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

export function listConfiguredMcpServersSync(options?: {
  cwd?: string;
  homeDir?: string;
}): McpServerConfig[] {
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
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const servers = (parsed.mcpServers || parsed.servers || {}) as Record<string, unknown>;
      for (const [name, val] of Object.entries(servers)) {
        if (typeof val === "object" && val !== null) {
          const s = val as Record<string, unknown>;
          // Project configuration intentionally overrides a same-named global
          // server, matching how skills and most MCP clients resolve scope.
          configs.set(name, {
            name,
            command: typeof s.command === "string" ? s.command : undefined,
            args: Array.isArray(s.args)
              ? s.args.filter((arg): arg is string => typeof arg === "string")
              : undefined,
            url: typeof s.url === "string" ? s.url : undefined,
            env: stringMap(s.env),
            headers: stringMap(s.headers),
            disabled: s.disabled === true,
            service: typeof s.service === "string" ? s.service : undefined,
            category: isCapabilityCategory(s.category) ? s.category : undefined,
            permission: isCapabilityPermission(s.permission) ? s.permission : undefined,
            exposure: typeof s.exposure === "string" && EXPOSURES.includes(s.exposure) ? s.exposure as McpExposure : undefined,
            description: typeof s.description === "string" ? s.description : undefined,
          });
        }
      }
    } catch {
      // Missing or malformed optional config files do not block startup.
    }
  }

  return [...configs.values()];
}

export async function listConfiguredMcpServers(options?: {
  cwd?: string;
  homeDir?: string;
}): Promise<McpServerConfig[]> {
  return listConfiguredMcpServersSync(options);
}

function isCapabilityCategory(value: unknown): value is HomelabCapabilityCategory {
  return (HOMELAB_CAPABILITY_CATEGORIES as readonly string[]).includes(value as string);
}

function isCapabilityPermission(value: unknown): value is HomelabCapabilityPermission {
  return value === "read" || value === "confirm" || value === "admin";
}
