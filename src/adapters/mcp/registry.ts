import { listConfiguredMcpServers, type McpServerConfig } from "./config.ts";
import { McpTransport } from "./transport.ts";
import type {
  HomelabCapabilityCategory,
  HomelabCapabilityPermission,
  McpServerInfo,
  McpServerState,
  McpToolInfo,
  McpCallResult,
} from "../../agent/extensions/mcp.ts";

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

type ExternalBinding = {
  qualifiedName: string;
  originalName: string;
  tool: McpToolInfo;
};

export type McpServerStatus = "disabled" | "configured" | "ready" | "error";

export type McpServerView = McpServerConfig & {
  status: McpServerStatus;
  error?: string;
  toolCount?: number;
};

type ServerState = {
  config: McpServerConfig;
  configKey: string;
  client: McpTransport;
  status: McpServerStatus;
  error?: string;
  bindings: ExternalBinding[];
};

function configKey(config: McpServerConfig): string {
  return JSON.stringify(config);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function qualifiedName(serverName: string, toolName: string): string {
  return `mcp:${serverName}/${toolName}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function serverDisabled(
  config: McpServerConfig,
  overrides: Map<string, boolean>,
): boolean {
  const enabled = overrides.get(config.name);
  return enabled === undefined ? config.disabled === true : !enabled;
}

async function loadStateTools(
  state: ServerState,
  overrides: Map<string, boolean>,
): Promise<ExternalBinding[]> {
  if (serverDisabled(state.config, overrides)) {
    state.status = "disabled";
    state.bindings = [];
    return [];
  }
  if (!state.config.command && !state.config.url) {
    throw new Error("MCP server must define command or url");
  }
  const rawTools = await state.client.listTools();
  state.bindings = rawTools.map((raw) => ({
    qualifiedName: qualifiedName(state.config.name, raw.name),
    originalName: raw.name,
    tool: (() => {
      const name = qualifiedName(state.config.name, raw.name);
      const description = raw.description ?? `Tool ${raw.name} from ${state.config.name}`;
      return {
        id: name,
        name,
        description,
        inputSchema: asRecord(raw.inputSchema) ?? { type: "object" },
        outputSchema: asRecord(raw.outputSchema),
        annotations: asRecord(raw.annotations),
        originalName: raw.name,
        category: state.config.category ?? inferCategory(raw.name, description),
        permission: state.config.permission ?? inferPermission(raw.name, description, asRecord(raw.annotations)),
        service: state.config.service ?? state.config.name,
        source: "external" as const,
        serverName: state.config.name,
      };
    })(),
  }));
  state.status = "ready";
  state.error = undefined;
  return state.bindings;
}

/**
 * Keeps external MCP configuration synchronized with live transports.
 * Agent code consumes this registry as a capability port; process and HTTP
 * details stay inside the integrations boundary.
 */
export function createMcpClientRegistry(options: {
  cwd?: string;
  homeDir?: string;
  timeoutMs?: number;
  serverStates?: readonly McpServerState[];
} = {}) {
  const states = new Map<string, ServerState>();
  const serverOverrides = new Map(
    (options.serverStates ?? []).map((state) => [state.name, state.enabled]),
  );
  const createClient = (config: McpServerConfig): McpTransport => new McpTransport(
    config,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.cwd,
  );

  async function sync(): Promise<McpServerConfig[]> {
    const configs = await listConfiguredMcpServers(options);
    const activeNames = new Set(configs.map((config) => config.name));
    for (const [name, state] of states) {
      if (!activeNames.has(name)) {
        state.client.close();
        states.delete(name);
      }
    }
    for (const config of configs) {
      const key = configKey(config);
      const previous = states.get(config.name);
      if (previous && previous.configKey === key) continue;
      previous?.client.close();
      states.set(config.name, {
        config,
        configKey: key,
        client: createClient(config),
        status: serverDisabled(config, serverOverrides) ? "disabled" : "configured",
        bindings: [],
      });
    }
    return configs;
  }

  let unregisterExitCleanup: (() => void) | undefined;
  const close = (): void => {
    for (const state of states.values()) state.client.close();
    states.clear();
    unregisterExitCleanup?.();
    unregisterExitCleanup = undefined;
  };
  const registry = {
    async listTools(): Promise<McpToolInfo[]> {
      await sync();
      const tools: McpToolInfo[] = [];
      for (const state of states.values()) {
        try {
          tools.push(...(await loadStateTools(state, serverOverrides)).map((binding) => binding.tool));
        } catch (error) {
          state.status = "error";
          state.error = errorText(error);
          state.bindings = [];
        }
      }
      return tools;
    },
    async listServers(): Promise<McpServerView[]> {
      await sync();
      return [...states.values()].map((state) => ({
        ...state.config,
        disabled: serverDisabled(state.config, serverOverrides),
        status: state.status,
        error: state.error,
        toolCount: state.bindings.length || undefined,
      }));
    },
    async setServerEnabled(
      name: string,
      enabled: boolean,
    ): Promise<McpServerInfo | undefined> {
      await sync();
      const state = states.get(name);
      if (!state) return undefined;
      serverOverrides.set(name, enabled);
      state.client.close();
      state.client = createClient(state.config);
      state.status = enabled ? "configured" : "disabled";
      state.error = undefined;
      state.bindings = [];
      return {
        ...state.config,
        disabled: !enabled,
        status: state.status,
      };
    },
    async invokeToolResult(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
      if (!name.startsWith("mcp:")) throw new Error(`invalid MCP tool name: ${name}`);
      await sync();
      const rest = name.slice("mcp:".length);
      const separator = rest.indexOf("/");
      if (separator <= 0) throw new Error(`invalid MCP tool name: ${name}`);
      const serverName = rest.slice(0, separator);
      const originalName = rest.slice(separator + 1);
      const state = states.get(serverName);
      if (!state) throw new Error(`unknown MCP server: ${serverName}`);
      if (serverDisabled(state.config, serverOverrides)) {
        throw new Error(`MCP server disabled: ${serverName}`);
      }
      if (!state.bindings.some((binding) => binding.originalName === originalName)) {
        try {
          await loadStateTools(state, serverOverrides);
        } catch (error) {
          state.status = "error";
          state.error = errorText(error);
          throw error;
        }
      }
      if (!state.bindings.some((binding) => binding.originalName === originalName)) {
        throw new Error(`unknown MCP tool: ${name}`);
      }
      return state.client.callToolResult(originalName, args, signal);
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
