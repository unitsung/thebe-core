import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  CustomToolDefinition,
  NormalizedEvent,
  PermissionHandler,
  RuntimeMcpOptions,
  RuntimeMcpServer,
} from "../../agent/runtime/interface.ts";
import {
  REDACTED,
  redactToolOutput,
  summarizeArgs,
} from "../../agent/security/redaction.ts";
import { fenceToolOutput } from "../../agent/security/untrusted-fence.ts";
import { mcpServerEnv } from "../mcp/env.ts";

type ToolList = {
  tools: Array<{
    name: string;
    title?: string;
    description?: string;
    inputSchema: unknown;
  }>;
};

type ToolResult = {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
};

export type ExternalMcpClient = {
  listTools(): Promise<ToolList>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    options?: { signal?: AbortSignal }
  ): Promise<ToolResult>;
  close(): Promise<void>;
};

export type ExternalMcpSession = {
  tools: CustomToolDefinition[];
  close(): Promise<void>;
};

export type ExternalMcpConnect = (
  server: RuntimeMcpServer,
  cwd: string
) => Promise<ExternalMcpClient>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function serverPrefix(name: string): string {
  return `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}__`;
}

function resultText(result: ToolResult): string {
  const parts: string[] = [];
  for (const value of result.content ?? []) {
    const block = record(value);
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.filter(Boolean).join("\n");
}

function redactStructured(value: unknown): unknown {
  if (typeof value === "string") return redactToolOutput(value);
  if (Array.isArray(value)) return value.map(redactStructured);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(password|token|secret|api_?key|credential)$/i.test(key)
          ? REDACTED
          : redactStructured(item),
      ])
    );
  }
  return value;
}

async function abortable<T>(
  value: PromiseLike<T> | T,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return await value;
  if (signal.aborted) throw new Error("cancelled");
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

async function defaultConnect(
  server: RuntimeMcpServer,
  cwd: string
): Promise<ExternalMcpClient> {
  const client = new Client({ name: "thebe-core", version: "0.1.0" });
  const transport = server.command
    ? new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: mcpServerEnv(server.env),
        cwd,
        stderr: "pipe",
      })
    : new StreamableHTTPClientTransport(new URL(server.url ?? ""), {
        requestInit: {
          headers: server.headers,
        },
      });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export async function createExternalMcpSession(options: {
  mcp: RuntimeMcpOptions;
  cwd: string;
  permissionHandler?: PermissionHandler;
  emit: (event: NormalizedEvent) => void;
  connectClient?: ExternalMcpConnect;
}): Promise<ExternalMcpSession> {
  const connect = options.connectClient ?? defaultConnect;
  const clients: ExternalMcpClient[] = [];
  const tools: CustomToolDefinition[] = [];
  const names = new Set<string>();
  try {
    for (const server of options.mcp.servers()) {
      if (!server.enabled || server.exposure === "hidden") continue;
      const client = await connect(server, options.cwd);
      clients.push(client);
      const listed = await client.listTools();
      for (const remote of listed.tools) {
        const name = `${serverPrefix(server.name)}${remote.name}`;
        if (names.has(name)) {
          throw new Error(`Duplicate external MCP tool name: ${name}`);
        }
        names.add(name);
        const needsApproval = server.permission
          ? server.permission !== "read"
          : server.readTools?.includes(remote.name) !== true;
        tools.push({
          name,
          label: remote.title ?? remote.name,
          description: remote.description ?? `${server.name}: ${remote.name}`,
          parameters: remote.inputSchema,
          ...(server.exposure === "direct"
            ? { exposure: "direct" as const }
            : {}),
          execute: async (toolCallId, input, signal) => {
            const call = { toolName: name, toolCallId, input };
            const blocked = await options.mcp.beforeCall(call);
            if (blocked) {
              return {
                content: [
                  {
                    type: "text",
                    text: fenceToolOutput(
                      name,
                      redactToolOutput(blocked.block)
                    ),
                  },
                ],
                isError: true,
              };
            }
            const startedAt = Date.now();
            if (needsApproval) {
              const handler = options.permissionHandler;
              if (!handler) {
                return {
                  content: [{ type: "text", text: "approval unavailable" }],
                  isError: true,
                };
              }
              const permissionId = randomUUID();
              const request = {
                permissionId,
                toolName: name,
                toolCallId,
                args: input,
                argsSummary: summarizeArgs(input),
                risk: "high" as const,
              };
              const requestApproval = async () => {
                options.emit({
                  type: "permission_requested",
                  permissionId,
                  toolName: name,
                  toolCallId,
                  argsSummary: request.argsSummary,
                  risk: request.risk,
                });
                return await abortable(handler.request(request), signal);
              };
              if (handler.preflight) {
                const decision = await abortable(
                  handler.preflight(request),
                  signal
                );
                if (decision === "deny") {
                  return {
                    content: [{ type: "text", text: "denied by policy" }],
                    isError: true,
                  };
                }
                if (
                  decision !== "allow" &&
                  (await requestApproval()) !== "allow"
                ) {
                  return {
                    content: [{ type: "text", text: "denied by user" }],
                    isError: true,
                  };
                }
              } else if ((await requestApproval()) !== "allow") {
                return {
                  content: [{ type: "text", text: "denied by user" }],
                  isError: true,
                };
              }
            }

            let result: ToolResult;
            try {
              result = await client.callTool(
                { name: remote.name, arguments: record(input) },
                signal ? { signal } : undefined
              );
            } catch (error) {
              result = {
                content: [
                  {
                    type: "text",
                    text:
                      error instanceof Error ? error.message : String(error),
                  },
                ],
                isError: true,
              };
            }
            const rawText = resultText(result);
            const text = redactToolOutput(rawText);
            const structured =
              result.structuredContent === undefined
                ? undefined
                : redactStructured(result.structuredContent);
            const redacted =
              text !== rawText ||
              JSON.stringify(structured) !==
                JSON.stringify(result.structuredContent);
            const output = fenceToolOutput(name, text);
            await options.mcp.afterCall(call, {
              bytes: Buffer.byteLength(output),
              isError: result.isError === true,
              redacted,
              durationMs: Date.now() - startedAt,
            });
            return {
              content: [{ type: "text", text: output }],
              ...(structured === undefined
                ? {}
                : { details: { structuredContent: structured } }),
              ...(result.isError ? { isError: true } : {}),
            };
          },
        });
      }
    }
  } catch (error) {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    throw error;
  }

  let closed: Promise<void> | undefined;
  return {
    tools,
    close() {
      closed ??= Promise.all(
        clients.map((client) => client.close().catch(() => {}))
      ).then(() => {});
      return closed;
    },
  };
}
