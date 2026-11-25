import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ThebeAgent } from "../../agent/interface.ts";
import { createThebeHttpContext } from "../http/context.ts";
import { handleMcp } from "../http/routes/mcp.ts";

const MAX_STDIO_MESSAGE_BYTES = 10 * 1024 * 1024;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const NAMED_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

export type McpStdioServer = {
  /** Handles one newline-delimited JSON-RPC message and returns one output line, if a response is due. */
  handleLine(line: string): Promise<string | undefined>;
};

/**
 * The local MCP transport. It uses the same route as `/mcp`, so tools/list, approvals, irreversible
 * checks, quiesce behavior and audit are shared. A spawned stdio process is an explicit local caller
 * with the same authority as the owner's shared token, never an unauthenticated bypass.
 */
export function createMcpStdioServer(options: {
  agent: ThebeAgent;
  version: string;
  callerName?: string;
}): McpStdioServer {
  const caller = {
    name: options.callerName ?? "stdio",
    writes: true,
    irreversible: true,
  };

  return {
    async handleLine(line) {
      if (Buffer.byteLength(line) > MAX_STDIO_MESSAGE_BYTES) {
        return JSON.stringify(
          rpcError(null, -32600, "Request exceeds the 10MB stdio limit")
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(line);
      } catch {
        return JSON.stringify(rpcError(null, -32700, "Parse error"));
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return JSON.stringify(
          rpcError(null, -32600, "Expected one JSON-RPC object")
        );
      }
      const request = requestFor(body as Record<string, unknown>);
      const response = await handleMcp(
        createThebeHttpContext(request, {
          version: options.version,
          agent: options.agent,
          caller,
          path: "/mcp",
        })
      );
      if (response.status === 202 || response.status === 204) return undefined;
      return (await response.text()) || undefined;
    },
  };
}

/** Runs the newline-delimited protocol loop. stdout is reserved for these returned messages. */
export async function serveMcpStdio(options: {
  server: McpStdioServer;
  input: Readable;
  output: Writable;
  signal?: AbortSignal;
  maxLineBytes?: number;
}): Promise<void> {
  const input = createInterface({
    input: options.input,
    crlfDelay: Infinity,
    terminal: false,
  });
  const maxBytes = options.maxLineBytes ?? MAX_STDIO_MESSAGE_BYTES;
  const abort = () => input.close();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const line of input) {
      if (options.signal?.aborted) break;
      if (!line.trim()) continue;
      const response =
        Buffer.byteLength(line) > maxBytes
          ? JSON.stringify(
              rpcError(null, -32600, "Request exceeds the stdio limit")
            )
          : await options.server.handleLine(line);
      if (!response) continue;
      await writeLine(options.output, response);
      if (options.signal?.aborted) break;
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    closeReadline(input);
  }
}

function requestFor(body: Record<string, unknown>): Request {
  const method = typeof body.method === "string" ? body.method : "";
  const params =
    body.params &&
    typeof body.params === "object" &&
    !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  const meta =
    params._meta &&
    typeof params._meta === "object" &&
    !Array.isArray(params._meta)
      ? (params._meta as Record<string, unknown>)
      : {};
  const protocolVersion =
    typeof meta[PROTOCOL_VERSION_META] === "string"
      ? meta[PROTOCOL_VERSION_META]
      : undefined;
  const headers = new Headers({ "content-type": "application/json" });
  if (protocolVersion && method !== "initialize") {
    headers.set(
      "mcp-protocol-version",
      protocolVersion || MODERN_PROTOCOL_VERSION
    );
    headers.set("mcp-method", method);
    if (NAMED_METHODS.has(method)) {
      const value =
        method === "resources/read"
          ? params.uri
          : typeof params.name === "string"
            ? params.name
            : "";
      if (typeof value === "string")
        headers.set("mcp-name", headerValue(value));
    }
  }
  return new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function headerValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?base64?${Buffer.from(value).toString("base64")}?=`;
}

function rpcError(
  id: unknown,
  code: number,
  message: string
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeLine(output: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(`${line}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeReadline(input: ReadlineInterface): void {
  input.close();
}
