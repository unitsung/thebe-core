import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type {
  CustomToolDefinition,
  NormalizedEvent,
  PermissionHandler,
} from "../agent/runtime/interface.ts";
import { summarizeArgs } from "../agent/security/redaction.ts";

const MAX_BRIDGE_BODY_BYTES = 10 * 1024 * 1024;
const SESSION_PATH = /^\/sessions\/([^/]+)\/mcp$/;
const MODERN_PROTOCOL_VERSION = "2026-07-28";

type SessionBinding = {
  customTools: readonly CustomToolDefinition[];
  permissionHandler?: PermissionHandler;
  toolsRequiringApproval?: readonly string[];
  emit(event: NormalizedEvent): void;
};
type RegisteredSession = SessionBinding & { active: Set<AbortController> };

export type InternalMcpBridge = {
  url: string;
  registerSession(sessionId: string, binding: SessionBinding): { url: string };
  unregisterSession(sessionId: string): void;
  close(): Promise<void>;
};

type RequestHandler = {
  handle(request: Request): Promise<Response>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const header = request.headers["x-thebe-token"];
  return Array.isArray(header) ? header[0] : header;
}

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(
  id: unknown,
  code: number,
  message: string
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function cancelledResponse(id: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  return {
    status: 200,
    body: mcpResult(id, {
      content: [{ type: "text", text: "cancelled" }],
      isError: true,
    }),
  };
}

async function abortable<T>(
  value: PromiseLike<T> | T,
  signal: AbortSignal
): Promise<T> {
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

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BRIDGE_BODY_BYTES) {
      throw Object.assign(new Error("request_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleSessionMcp(
  request: IncomingMessage,
  binding: RegisteredSession,
  controller: AbortController
): Promise<{ status: number; body?: Record<string, unknown> }> {
  const body = record(JSON.parse(await readBody(request)));
  const id = body.id ?? null;
  const method = typeof body.method === "string" ? body.method : "";
  if (
    method.startsWith("notifications/") ||
    (!method && ("result" in body || "error" in body))
  ) {
    return { status: 202 };
  }
  if (method === "initialize") {
    const params = record(body.params);
    return {
      status: 200,
      body: mcpResult(id, {
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "thebe-session-tools", version: "0.1.0" },
      }),
    };
  }
  if (method === "ping") {
    return { status: 200, body: mcpResult(id, {}) };
  }
  if (method === "server/discover") {
    return {
      status: 200,
      body: mcpResult(id, {
        supportedVersions: [MODERN_PROTOCOL_VERSION, "2025-06-18"],
        capabilities: { tools: { listChanged: false } },
        ttlMs: 300_000,
        cacheScope: "public",
      }),
    };
  }
  if (method === "tools/list") {
    return {
      status: 200,
      body: mcpResult(id, {
        tools: binding.customTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
          annotations: {
            readOnlyHint: tool.requiresApproval !== true,
            destructiveHint: tool.requiresApproval === true,
          },
        })),
        ttlMs: 300_000,
        cacheScope: "private",
      }),
    };
  }
  if (method !== "tools/call") {
    return { status: 200, body: mcpError(id, -32601, "Method not found") };
  }
  const params = record(body.params);
  const name = typeof params.name === "string" ? params.name : "";
  const tool = binding.customTools.find((item) => item.name === name);
  if (!tool) {
    return {
      status: 200,
      body: mcpError(id, -32602, `Unknown tool: ${name}`),
    };
  }
  const args = params.arguments;
  const requiresApproval =
    tool.requiresApproval === true ||
    binding.toolsRequiringApproval?.includes(name) === true;
  binding.active.add(controller);
  try {
    if (requiresApproval) {
      const handler = binding.permissionHandler;
      if (!handler) {
        return {
          status: 200,
          body: mcpResult(id, {
            content: [{ type: "text", text: "approval unavailable" }],
            isError: true,
          }),
        };
      }
      const callId =
        typeof params.callId === "string"
          ? params.callId
          : `session-tool-${String(id)}`;
      const permission = {
        permissionId: `dsh:${name}:${randomUUID()}`,
        toolName: name,
        toolCallId: callId,
        args,
      };
      const requestApproval = async () => {
        binding.emit({
          type: "permission_requested",
          permissionId: permission.permissionId,
          toolName: name,
          toolCallId: callId,
          ...(args === undefined
            ? {}
            : {
                argsSummary: summarizeArgs(args),
              }),
          risk: "standard",
        });
        return await abortable(handler.request(permission), controller.signal);
      };
      if (handler.preflight) {
        const decision = await abortable(
          handler.preflight(permission),
          controller.signal
        );
        if (controller.signal.aborted) return cancelledResponse(id);
        if (decision === "deny") {
          return {
            status: 200,
            body: mcpResult(id, {
              content: [{ type: "text", text: "denied by policy" }],
              isError: true,
            }),
          };
        }
        if (decision !== "allow" && (await requestApproval()) !== "allow") {
          if (controller.signal.aborted) return cancelledResponse(id);
          return {
            status: 200,
            body: mcpResult(id, {
              content: [{ type: "text", text: "user denied" }],
              isError: true,
            }),
          };
        }
      } else if ((await requestApproval()) !== "allow") {
        if (controller.signal.aborted) return cancelledResponse(id);
        return {
          status: 200,
          body: mcpResult(id, {
            content: [{ type: "text", text: "user denied" }],
            isError: true,
          }),
        };
      }
      if (controller.signal.aborted) return cancelledResponse(id);
    }
    const result = await tool.execute(
      typeof params.callId === "string" ? params.callId : String(id),
      args,
      controller.signal
    );
    if (controller.signal.aborted) return cancelledResponse(id);
    return {
      status: 200,
      body: mcpResult(id, {
        content: result.content,
        ...(result.details ? { structuredContent: result.details } : {}),
        ...(result.isError ? { isError: true } : {}),
      }),
    };
  } catch (error) {
    if (controller.signal.aborted) return cancelledResponse(id);
    throw error;
  } finally {
    binding.active.delete(controller);
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * A loopback-only HTTP face over the same Core request handler. DSH's MCP
 * client can therefore call the current Core process and its session-specific
 * custom tools even when the entry point is the TUI, one-shot CLI, or
 * `thebe-mcp` instead of `dist/serve.js`.
 */
export async function startInternalMcpBridge(options: {
  token: string;
  handler: RequestHandler;
}): Promise<InternalMcpBridge> {
  const sessions = new Map<string, RegisteredSession>();
  let port = 0;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const controller = new AbortController();
      incoming.once("aborted", () => controller.abort());
      outgoing.once("close", () => {
        if (!outgoing.writableEnded) controller.abort();
      });
      if (bearerToken(incoming) !== options.token) {
        writeJson(outgoing, 401, { error: "unauthorized" });
        return;
      }
      const path = new URL(incoming.url ?? "/", `http://127.0.0.1:${port}`)
        .pathname;
      const sessionId = SESSION_PATH.exec(path)?.[1];
      if (sessionId) {
        const binding = sessions.get(decodeURIComponent(sessionId));
        if (!binding) {
          writeJson(outgoing, 404, { error: "unknown session" });
          return;
        }
        if (incoming.method !== "POST") {
          writeJson(outgoing, 405, { error: "method_not_allowed" });
          return;
        }
        const response = await handleSessionMcp(incoming, binding, controller);
        if (response.body) writeJson(outgoing, response.status, response.body);
        else outgoing.writeHead(response.status).end();
        return;
      }
      if (path !== "/mcp") {
        writeJson(outgoing, 404, { error: "not_found" });
        return;
      }
      const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
        method: incoming.method,
        headers: Object.entries(incoming.headers).flatMap(([key, value]) =>
          value === undefined
            ? []
            : Array.isArray(value)
              ? value.map((item) => [key, item] as [string, string])
              : [[key, value] as [string, string]]
        ),
        ...(["GET", "HEAD"].includes(incoming.method ?? "GET")
          ? {}
          : { body: await readBody(incoming) }),
      });
      const response = await options.handler.handle(request);
      const headers = Object.fromEntries(
        [...response.headers].filter(
          ([key]) =>
            !["connection", "content-length", "transfer-encoding"].includes(
              key.toLowerCase()
            )
        )
      );
      outgoing.writeHead(response.status, headers);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const status = (error as { status?: unknown }).status === 413 ? 413 : 500;
      writeJson(outgoing, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    url: `${base}/mcp`,
    registerSession(sessionId, binding) {
      const previous = sessions.get(sessionId);
      for (const active of previous?.active ?? []) active.abort();
      sessions.set(sessionId, { ...binding, active: new Set() });
      return { url: `${base}/sessions/${encodeURIComponent(sessionId)}/mcp` };
    },
    unregisterSession(sessionId) {
      for (const active of sessions.get(sessionId)?.active ?? []) {
        active.abort();
      }
      sessions.delete(sessionId);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const binding of sessions.values()) {
          for (const active of binding.active) active.abort();
        }
        sessions.clear();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
