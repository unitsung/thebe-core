import { spawn } from "node:child_process";
import type { McpServerConfig } from "./config.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcMessage = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

/**
 * MCP JSON-RPC transport for a single external server.
 *
 * The registry owns discovery and lifecycle; this adapter only knows how to
 * speak stdio or Streamable HTTP and deliberately exposes no server catalog.
 */
export class McpTransport {
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

  constructor(config: McpServerConfig, timeoutMs: number, cwd?: string) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    if (!config.command) {
      this.child = undefined;
      return;
    }
    const child = spawn(config.command, config.args ?? [], {
      cwd,
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
