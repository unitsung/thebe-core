import { listConfiguredMcpServers, type McpServerConfig } from "./config.ts";
import { McpTransport } from "./transport.ts";
import type { McpToolInfo } from "../../agent/extensions/mcp.ts";

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

async function loadStateTools(state: ServerState): Promise<ExternalBinding[]> {
  if (state.config.disabled) {
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
    tool: {
      name: qualifiedName(state.config.name, raw.name),
      description: raw.description ?? `Tool ${raw.name} from ${state.config.name}`,
      inputSchema: asRecord(raw.inputSchema) ?? { type: "object" },
      source: "external",
      serverName: state.config.name,
    },
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
} = {}) {
  const states = new Map<string, ServerState>();

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
        client: new McpTransport(
          config,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          options.cwd,
        ),
        status: config.disabled ? "disabled" : "configured",
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
          tools.push(...(await loadStateTools(state)).map((binding) => binding.tool));
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
        status: state.status,
        error: state.error,
        toolCount: state.bindings.length || undefined,
      }));
    },
    async invokeTool(name: string, args: unknown): Promise<string | undefined> {
      if (!name.startsWith("mcp:")) return undefined;
      await sync();
      const rest = name.slice("mcp:".length);
      const separator = rest.indexOf("/");
      if (separator <= 0) throw new Error(`invalid MCP tool name: ${name}`);
      const serverName = rest.slice(0, separator);
      const originalName = rest.slice(separator + 1);
      const state = states.get(serverName);
      if (!state) throw new Error(`unknown MCP server: ${serverName}`);
      if (state.config.disabled) throw new Error(`MCP server disabled: ${serverName}`);
      if (!state.bindings.some((binding) => binding.originalName === originalName)) {
        try {
          await loadStateTools(state);
        } catch (error) {
          state.status = "error";
          state.error = errorText(error);
          throw error;
        }
      }
      if (!state.bindings.some((binding) => binding.originalName === originalName)) {
        throw new Error(`unknown MCP tool: ${name}`);
      }
      return state.client.callTool(originalName, args);
    },
    close,
  };
  unregisterExitCleanup = registerExitCleanup(close);
  return registry;
}
