import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.ts";

/** One standard SDK client per server, shared by product and model calls. */
export class McpTransport {
  private readonly client = new Client({ name: "thebe-core", version: "0.1.0" });
  private opening?: Promise<void>;
  private closed = false;

  constructor(private readonly config: McpServerConfig,
    private readonly timeoutMs: number, private readonly cwd?: string) {}

  private connect(): Promise<void> {
    if (this.closed) throw new Error("MCP client closed");
    this.opening ??= (async () => {
      const transport = this.config.command
        ? new StdioClientTransport({ command: this.config.command, args: this.config.args,
            env: this.config.env, cwd: this.cwd, stderr: "ignore" })
        : this.config.url
          ? new StreamableHTTPClientTransport(new URL(this.config.url), {
              requestInit: { headers: this.config.headers },
            })
          : undefined;
      if (!transport) throw new Error("MCP server has neither command nor url");
      await this.client.connect(transport, { timeout: this.timeoutMs });
      if (this.closed) await this.client.close();
    })().catch((error) => {
      this.opening = undefined;
      throw error;
    });
    return this.opening;
  }

  async listTools(): Promise<Tool[]> {
    await this.connect();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools({ cursor }, { timeout: this.timeoutMs });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callToolResult(name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    await this.connect();
    // Never automatically replay a call: it may already have changed state.
    return await this.client.callTool({ name,
      arguments: args && typeof args === "object" && !Array.isArray(args)
        ? args as Record<string, unknown> : {},
    }, undefined, { timeout: this.timeoutMs, signal }) as CallToolResult;
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const result = await this.callToolResult(name, args);
    const text = result.content.map((block) => block.type === "text" ? block.text : JSON.stringify(block)).join("\n");
    if (result.isError) throw new Error(text || "MCP tool failed");
    return text || JSON.stringify(result.structuredContent ?? result);
  }

  close(): void {
    this.closed = true;
    void this.client.close().catch(() => {});
  }
}
