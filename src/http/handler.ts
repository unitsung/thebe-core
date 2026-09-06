import { createPolicyEngine } from "../policy/policy-engine.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import {
  CONTAINER_TOOL_NAMES,
  createContainerTools,
} from "../tools/container-tools.ts";

export type ThebeAskFn = (
  text: string,
) => Promise<{ text: string; tools: string[] }>;

export type ThebeHttpHandlerOptions = {
  version: string;
  provider: ContainerInfoProvider;
  token?: string;
  ask?: ThebeAskFn;
  now?: () => Date;
  callerId?: string;
};

const MCP_EVENT_TOOLS = ["list_core_events", "diagnose_from_events"] as const;

const ALIASES: Record<string, (typeof CONTAINER_TOOL_NAMES)[number]> = {
  containers_summary: "container.status_summary",
  container_logs: "container.logs",
};

export function createThebeHttpHandler(options: ThebeHttpHandlerOptions) {
  const now = options.now ?? (() => new Date());
  const callerId = options.callerId ?? "ios";
  const policy = createPolicyEngine({ now });
  const tools = createContainerTools(options.provider, { policy, callerId });
  const token = options.token?.trim() || undefined;

  async function handle(request: Request): Promise<Response> {
    if (token) {
      const got = request.headers.get("X-Thebe-Token") ?? "";
      if (got !== token) {
        return json({ ok: false }, 401);
      }
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (request.method === "GET" && path === "/v1/health") {
      return json({ ok: true, version: options.version });
    }
    if (request.method === "GET" && path === "/v1/events") {
      return json({ events: [] });
    }
    if (request.method === "POST" && path === "/v1/devices") {
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/v1/ask") {
      return handleAsk(request);
    }
    if (request.method === "POST" && path === "/mcp") {
      return handleMcp(request);
    }
    return json({ ok: false }, 404);
  }

  async function handleAsk(request: Request): Promise<Response> {
    if (!options.ask) {
      return json({ text: "", tools: [] }, 503);
    }
    const body = await readJson(request);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return json({ text: "", tools: [] }, 400);
    }
    try {
      const reply = await options.ask(text);
      return json({ text: reply.text, tools: reply.tools });
    } catch (error) {
      return json(
        {
          text: "",
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  }

  async function handleMcp(request: Request): Promise<Response> {
    const body = await readJson(request);
    const id = body.id ?? 1;
    const method = body.method;
    if (method === "tools/list") {
      return json({
        jsonrpc: "2.0",
        id,
        result: { tools: listedTools() },
      });
    }
    if (method === "tools/call") {
      const params = asObject(body.params);
      const name = typeof params.name === "string" ? params.name : "";
      try {
        const text = await callTool(name, params.arguments);
        return json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] },
        });
      } catch (error) {
        return json({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });
  }

  function listedTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    const container = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object" },
    }));
    return [
      ...container,
      {
        name: "list_core_events",
        description: "List recent webhook events stored on Thebe Core.",
        inputSchema: { type: "object" },
      },
      {
        name: "diagnose_from_events",
        description: "Summarize the most likely issue from Thebe Core events.",
        inputSchema: { type: "object" },
      },
    ];
  }

  async function callTool(name: string, args: unknown): Promise<string> {
    if ((MCP_EVENT_TOOLS as readonly string[]).includes(name)) {
      if (name === "list_core_events") {
        return JSON.stringify({ events: [] });
      }
      return JSON.stringify({ summary: "No recent Core events." });
    }
    const mapped = ALIASES[name] ?? name;
    const tool = tools.find((item) => item.name === mapped);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }
    const result = await tool.execute("http", (asObject(args) ?? {}) as never);
    return result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  return { handle };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return asObject(parsed);
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
