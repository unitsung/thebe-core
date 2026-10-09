import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import type { CallToolResult, Tool } from "@earendil-works/pi-mcp";
import type { McpServerConfig } from "./config.ts";
import { mcpServerEnv } from "./env.ts";

/**
 * A lazy connection through Pi's MCP client, for the product inventory outside any session.
 * Model calls never use it: the runtime connects its own servers.
 */
export class McpConnection {
  private readonly client: McpClient;
  private opening?: Promise<void>;
  private closed = false;

  constructor(private readonly config: McpServerConfig,
    private readonly timeoutMs: number, private readonly cwd?: string) {
    this.client = new McpClient({ name: "thebe-core", version: "0.1.0", requestTimeoutMs: timeoutMs });
  }

  private connect(): Promise<void> {
    if (this.closed) throw new Error("MCP client closed");
    this.opening ??= (async () => {
      const transport = this.config.command
        ? new StdioTransport({ command: this.config.command, args: this.config.args, env: mcpServerEnv(this.config.env), inheritEnv: false, cwd: this.cwd })
        : this.config.url
          ? new StreamableHttpTransport({ url: this.config.url, headers: this.config.headers })
          : undefined;
      if (!transport) throw new Error("MCP server has neither command nor url");
      await this.client.connect(transport);
      if (this.closed) await this.client.close();
    })().catch((error) => {
      this.opening = undefined;
      throw error;
    });
    return this.opening;
  }

  async listTools(): Promise<Tool[]> {
    await this.connect();
    return this.client.listTools();
  }

  async callToolResult(name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    await this.connect();
    // Never automatically replay a call: it may already have changed state.
    return this.client.callTool(name, args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown> : {}, { signal });
  }

  close(): void {
    this.closed = true;
    void this.client.close().catch(() => {});
  }
}

export { toLlmContent };
