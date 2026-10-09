import { addConfiguredMcpServer, listConfiguredMcpServersSync, removeConfiguredMcpServer, type McpServerConfig } from "./config.ts";
import { McpConnection } from "./connection.ts";
import type {
  HomelabCapabilityCategory,
  HomelabCapabilityPermission,
  McpServerInfo,
  McpServerState,
  McpToolInfo,
  McpCallResult,
  McpServerRegistration,
} from "../../agent/extensions/mcp.ts";
import type { RuntimeMcpServer } from "../../agent/runtime/interface.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const activeRegistryCleanups = new Set<() => void>();
let exitCleanupInstalled = false;

function registerExitCleanup(cleanup: () => void): () => void {
  activeRegistryCleanups.add(cleanup);
  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.once("exit", () => {
      for (const close of activeRegistryCleanups) close();
    });
  }
  return () => activeRegistryCleanups.delete(cleanup);
}

/** A server's configured state. Whether it is reachable is the runtime's connection, not this record. */
export type McpServerStatus = "disabled" | "configured";

export type McpServerView = McpServerConfig & { status: McpServerStatus };

type ServerState = {
  config: McpServerConfig;
  configKey: string;
  connection: McpConnection;
  tools: McpToolInfo[];
};

const configKey = (config: McpServerConfig): string => JSON.stringify(config);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const qualifiedName = (serverName: string, toolName: string): string => `mcp:${serverName}/${toolName}`;

function inferCategory(name: string, description: string): HomelabCapabilityCategory {
  const value = `${name} ${description}`.toLowerCase();
  if (/(file|folder|directory|nas|openlist|storage)/.test(value)) return "files";
  if (/(movie|music|anime|media|jellyfin|emby|navidrome|radarr|sonarr|lidarr)/.test(value)) return "media";
  if (/(download|torrent|aria2|qbittorrent|queue|cloudsaver)/.test(value)) return "downloads";
  if (/(container|docker|portainer|arcane)/.test(value)) return "containers";
  if (/(schedule|cron|task|automation|job)/.test(value)) return "automation";
  if (/(health|status|inspect|log|diagnos|monitor|uptime)/.test(value)) return "diagnostics";
  return "other";
}

function inferPermission(name: string, description: string, annotations?: Record<string, unknown>): HomelabCapabilityPermission {
  if (annotations?.destructiveHint === true) return "admin";
  const value = `${name} ${description}`.toLowerCase();
  if (/(delete|remove|destroy|admin|credential|permission|shutdown)/.test(value)) return "admin";
  if (/(create|update|write|save|submit|download|move|copy|rename|restart|start|stop|pause|resume|schedule|run)/.test(value)) return "confirm";
  return annotations?.readOnlyHint === true ? "read" : "confirm";
}

function serverDisabled(config: McpServerConfig, overrides: Map<string, boolean>): boolean {
  const enabled = overrides.get(config.name);
  return enabled === undefined ? config.disabled === true : !enabled;
}

/**
 * Product-side MCP inventory: configured servers, and tool lists for screens and capability calls
 * that run outside a session. A model call never goes through here; the runtime connects its own
 * servers from `runtimeServers()`.
 */
export function createMcpClientRegistry(options: {
  cwd?: string;
  homeDir?: string;
  timeoutMs?: number;
  serverStates?: readonly McpServerState[];
} = {}) {
  const states = new Map<string, ServerState>();
  let registrationQueue: Promise<void> = Promise.resolve();
  const serverOverrides = new Map(
    (options.serverStates ?? []).map((state) => [state.name, state.enabled]),
  );
  const createConnection = (config: McpServerConfig): McpConnection => new McpConnection(
    config, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.cwd,
  );

  function sync(): McpServerConfig[] {
    const configs = listConfiguredMcpServersSync(options);
    const activeNames = new Set(configs.map((config) => config.name));
    for (const [name, state] of states) {
      if (!activeNames.has(name)) {
        state.connection.close();
        states.delete(name);
      }
    }
    for (const config of configs) {
      const key = configKey(config);
      const previous = states.get(config.name);
      if (previous && previous.configKey === key) continue;
      previous?.connection.close();
      states.set(config.name, { config, configKey: key, connection: createConnection(config), tools: [] });
    }
    return configs;
  }

  let unregisterExitCleanup: (() => void) | undefined;
  const close = (): void => {
    for (const state of states.values()) state.connection.close();
    states.clear();
    unregisterExitCleanup?.();
    unregisterExitCleanup = undefined;
  };
  const serverView = (state: ServerState): McpServerView => ({
    ...state.config,
    disabled: serverDisabled(state.config, serverOverrides),
    status: serverDisabled(state.config, serverOverrides) ? "disabled" : "configured",
  });

  async function loadTools(state: ServerState): Promise<McpToolInfo[]> {
    if (serverDisabled(state.config, serverOverrides)) return [];
    if (!state.config.command && !state.config.url) throw new Error("MCP server must define command or url");
    const connection = state.connection;
    const raw = await connection.listTools();
    // A reconfiguration swaps the connection while this list is in flight.
    if (state.connection !== connection) return [];
    state.tools = raw.map((tool) => {
      const name = qualifiedName(state.config.name, tool.name);
      const description = tool.description ?? `Tool ${tool.name} from ${state.config.name}`;
      const annotations = asRecord(tool.annotations);
      return {
        id: name,
        name,
        description,
        inputSchema: asRecord(tool.inputSchema) ?? { type: "object" },
        outputSchema: asRecord(tool.outputSchema),
        annotations,
        originalName: tool.name,
        category: state.config.category ?? inferCategory(tool.name, description),
        permission: state.config.permission ?? inferPermission(tool.name, description, annotations),
        service: state.config.service ?? state.config.name,
        source: "external" as const,
        serverName: state.config.name,
      };
    });
    return state.tools;
  }

  const registry = {
    async addServer(input: McpServerRegistration): Promise<McpServerInfo> {
      const operation = registrationQueue.then(async () => {
        await addConfiguredMcpServer(input, options);
        serverOverrides.set(input.name, false);
        sync();
      });
      registrationQueue = operation.catch(() => {});
      await operation;
      return { name: input.name, command: input.command, url: input.url, status: "disabled", disabled: true };
    },
    async removeServer(name: string): Promise<boolean> {
      const operation = registrationQueue.then(async () => {
        const removed = await removeConfiguredMcpServer(name, options);
        serverOverrides.delete(name);
        sync();
        return removed;
      });
      registrationQueue = operation.then(() => {}, () => {});
      return operation;
    },
    /** Server list for the runtime's own MCP client: configuration plus the saved enabled state. */
    runtimeServers(): RuntimeMcpServer[] {
      return sync().map((config) => ({
        name: config.name,
        command: config.command,
        args: config.args,
        env: config.env,
        url: config.url,
        headers: config.headers,
        enabled: !serverDisabled(config, serverOverrides),
        description: config.description,
        exposure: config.exposure,
        permission: config.permission,
      }));
    },
    async listTools(): Promise<McpToolInfo[]> {
      sync();
      const tools: McpToolInfo[] = [];
      for (const state of states.values()) {
        try { tools.push(...await loadTools(state)); } catch { /* an unreachable server lists no tools */ }
      }
      return tools;
    },
    async listServers(): Promise<McpServerView[]> {
      sync();
      return [...states.values()].map(serverView);
    },
    async setServerEnabled(name: string, enabled: boolean): Promise<McpServerInfo | undefined> {
      sync();
      const state = states.get(name);
      if (!state) return undefined;
      serverOverrides.set(name, enabled);
      state.connection.close();
      state.connection = createConnection(state.config);
      state.tools = [];
      return serverView(state);
    },
    async invokeToolResult(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
      if (!name.startsWith("mcp:")) throw new Error(`invalid MCP tool name: ${name}`);
      sync();
      const rest = name.slice("mcp:".length);
      const separator = rest.indexOf("/");
      if (separator <= 0) throw new Error(`invalid MCP tool name: ${name}`);
      const serverName = rest.slice(0, separator);
      const originalName = rest.slice(separator + 1);
      const state = states.get(serverName);
      if (!state) throw new Error(`unknown MCP server: ${serverName}`);
      if (serverDisabled(state.config, serverOverrides)) throw new Error(`MCP server disabled: ${serverName}`);
      if (!state.tools.some((tool) => tool.originalName === originalName)) await loadTools(state);
      if (!state.tools.some((tool) => tool.originalName === originalName)) throw new Error(`unknown MCP tool: ${name}`);
      return await state.connection.callToolResult(originalName, args, signal) as unknown as McpCallResult;
    },
    async invokeTool(name: string, args: unknown): Promise<string | undefined> {
      if (!name.startsWith("mcp:")) return undefined;
      const result = await registry.invokeToolResult(name, args);
      const text = result.content.map((block) => block.type === "text" ? String(block.text) : JSON.stringify(block)).join("\n");
      if (result.isError) throw new Error(text || "MCP tool failed");
      return text || JSON.stringify(result.structuredContent ?? result);
    },
    close,
  };
  unregisterExitCleanup = registerExitCleanup(close);
  return registry;
}
