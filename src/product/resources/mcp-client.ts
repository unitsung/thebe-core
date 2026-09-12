import { spawn } from "node:child_process";
import { listConfiguredMcpServers, type McpServerConfig, type McpToolInfo } from "./mcp.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
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

type JsonRpcMessage = Record<string, unknown>;

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

function resultText(result: unknown): string {
  const record = asRecord(result);
  const content = record?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const block = asRecord(item);
        if (typeof block?.text === "string") return block.text;
        return block ? JSON.stringify(block) : String(item);
      })
      .join("\n");
    if (text) return text;
  }
  return JSON.stringify(result ?? null, null, 2);
}

function parseSse(text: string, expectedId: number): JsonRpcMessage | undefined {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as JsonRpcMessage;
      if (parsed.id === expectedId) return parsed;
    } catch {
      // Ignore keep-alive or non-JSON SSE frames.
    }
  }
  return undefined;
}

class McpTransport {
  private readonly config: McpServerConfig;
  private readonly timeoutMs: number;
  private readonly child: ReturnType<typeof spawn> | undefined;
  private buffer = "";
  private nextId = 1;
  private initialized = false;
  private sessionId: string | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(config: McpServerConfig, timeoutMs: number) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    if (!config.command) {
      this.child = undefined;
      return;
    }
    const child = spawn(config.command, config.args ?? [], {
      cwd: process.cwd(),
      env: { ...process.env, ...(config.env ?? {}) },
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          this.handleMessage(JSON.parse(line) as JsonRpcMessage);
        } catch {
          // A malformed server frame must not crash Thebe's process.
        }
      }
    });
    const rejectPending = (error: Error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    child.once("error", rejectPending);
    child.once("exit", (code, signal) => {
      rejectPending(new Error(`MCP server exited (${code ?? signal ?? "unknown"})`));
    });
  }

  private handleMessage(message: JsonRpcMessage): void {
    const id = message.id;
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = asRecord(message.error);
    if (error) {
      pending.reject(new Error(typeof error.message === "string" ? error.message : JSON.stringify(error)));
      return;
    }
    pending.resolve(message.result);
  }

  private async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    if (this.child) {
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, this.timeoutMs);
        timer.unref?.();
        this.pending.set(id, { resolve, reject, timer });
        this.child?.stdin?.write(`${message}\n`, (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          }
        });
      });
    }
    if (!this.config.url) throw new Error("MCP server has neither command nor url");
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(this.initialized ? { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } : {}),
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) this.sessionId = newSessionId;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${body.slice(0, 400)}`);
    }
    const message = response.headers.get("content-type")?.includes("text/event-stream")
      ? parseSse(body, id)
      : body.trim() ? JSON.parse(body) as JsonRpcMessage : undefined;
    if (!message) throw new Error(`MCP server returned no response for ${method}`);
    const error = asRecord(message.error);
    if (error) {
      throw new Error(typeof error.message === "string" ? error.message : JSON.stringify(error));
    }
    return message.result;
  }

  private async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (this.child) {
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      return;
    }
    if (!this.config.url) return;
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(this.initialized ? { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } : {}),
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok && response.status !== 202 && response.status !== 204) {
      throw new Error(`MCP notification HTTP ${response.status}`);
    }
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    if (!this.initialized) {
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "thebe-core", version: "0.1.0" },
      });
      await this.notify("notifications/initialized");
      this.initialized = true;
    }
    const result = asRecord(await this.request("tools/list"));
    const tools = result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((item) => {
      const tool = asRecord(item);
      return typeof tool?.name === "string"
        ? [{
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : undefined,
            inputSchema: tool.inputSchema,
          }]
        : [];
    });
  }

  async callTool(name: string, args: unknown): Promise<string> {
    if (!this.initialized) await this.listTools();
    return resultText(await this.request("tools/call", {
      name,
      arguments: asRecord(args) ?? {},
    }));
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP client closed"));
    }
    this.pending.clear();
    if (this.child && !this.child.killed) this.child.kill();
  }
}

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
        client: new McpTransport(config, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        status: config.disabled ? "disabled" : "configured",
        bindings: [],
      });
    }
    return configs;
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
