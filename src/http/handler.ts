import type { ThebeProduct } from "../product/service.ts";
import type {
  NormalizedEvent,
  PromptFile,
  PromptMode,
  ThinkingLevel,
} from "../runtime/types.ts";
import {
  estimatedDecodedBytes,
  isSupportedPromptFile,
  MAX_PROMPT_FILES,
  MAX_PROMPT_FILE_BYTES,
} from "../runtime/types.ts";
import {
  CONTAINER_TOOL_DESCRIPTIONS,
  CONTAINER_TOOL_NAMES,
} from "../tools/container-tools.ts";

export type ThebeHttpHandlerOptions = {
  version: string;
  token?: string;
  product?: ThebeProduct;
};

const MCP_EVENT_TOOLS = ["list_core_events", "diagnose_from_events"] as const;

const ALIASES: Record<string, (typeof CONTAINER_TOOL_NAMES)[number]> = {
  containers_summary: "container.status_summary",
  container_logs: "container.logs",
};

export function createThebeHttpHandler(options: ThebeHttpHandlerOptions) {
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
    if (path.startsWith("/v1/session") || path.startsWith("/v1/provider") || path.startsWith("/v1/model") || path.startsWith("/v1/auth")) {
      return handleProductApi(request, path);
    }
    if (request.method === "POST" && path === "/mcp") {
      return handleMcp(request);
    }
    return json({ ok: false }, 404);
  }

  async function handleProductApi(
    request: Request,
    path: string,
  ): Promise<Response> {
    const product = options.product;
    if (!product) {
      return json({ ok: false, error: "product service unavailable" }, 503);
    }
    const url = new URL(request.url);
    const parts = path.split("/").filter(Boolean);
    try {
      if (parts[0] === "v1" && parts[1] === "session") {
        return await handleSession(request, url, parts, product);
      }
      if (request.method === "GET" && path === "/v1/provider") {
        const all = url.searchParams.get("all") === "true";
        return json({
          providers: await product.listProviders({ all }),
        });
      }
      if (request.method === "GET" && path === "/v1/provider/auth") {
        return json({ providers: await product.auth().listProviders() });
      }
      if (
        request.method === "POST" &&
        parts[0] === "v1" &&
        parts[1] === "provider" &&
        parts[3] === "oauth"
      ) {
        const providerId = parts[2] ?? "";
        if (parts[4] === "authorize") {
          const result = await product.auth().authorizeOAuth(providerId);
          if ("connected" in result && result.connected) {
            return json({ ok: true, connected: true, providerId });
          }
          return json({ ok: true, ...result }, 202);
        }
        if (parts[4] === "callback") {
          const body = await readJson(request);
          const input = oauthCallbackInput(body);
          if (!input) {
            return json(
              { ok: false, error: "callback url or code required" },
              400,
            );
          }
          await product.auth().submitOAuthCallback(providerId, input);
          return json({ ok: true, providerId });
        }
      }
      if (request.method === "GET" && path === "/v1/model") {
        const all = url.searchParams.get("all") === "true";
        const providerId = url.searchParams.get("provider") ?? undefined;
        const models = all
          ? await product.listModels({ all: true, providerId })
          : await product.listAvailableModels({ providerId });
        return json({ models });
      }
      if (
        request.method === "PUT" &&
        parts[0] === "v1" &&
        parts[1] === "auth" &&
        parts[2]
      ) {
        const body = await readJson(request);
        const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
        if (!apiKey) {
          return json({ ok: false, error: "apiKey required" }, 400);
        }
        await product.auth().setApiKey(parts[2], apiKey);
        return json({ ok: true });
      }
      if (
        request.method === "DELETE" &&
        parts[0] === "v1" &&
        parts[1] === "auth" &&
        parts[2]
      ) {
        await product.auth().logout(parts[2]);
        return json({ ok: true });
      }
      return json({ ok: false }, 404);
    } catch (error) {
      return productError(error);
    }
  }

  async function handleSession(
    request: Request,
    url: URL,
    parts: string[],
    product: ThebeProduct,
  ): Promise<Response> {
    const method = request.method;
    const id = parts[2];
    const action = parts[3];
    const extra = parts[4];

    if (method === "GET" && parts.length === 2) {
      return json({ sessions: await product.listSessions() });
    }
    if (method === "POST" && parts.length === 2) {
      const body = await readJson(request);
      const model = asObject(body.model);
      const providerId =
        typeof model.providerId === "string" ? model.providerId : "";
      const modelId = typeof model.modelId === "string" ? model.modelId : "";
      if (body.model !== undefined && (!providerId || !modelId)) {
        return json(
          { error: "model.providerId and model.modelId required" },
          400,
        );
      }
      return json(
        await product.createSession({
          title: typeof body.title === "string" ? body.title : undefined,
          labels: asStringMap(body.labels),
          selectedContext: body.selectedContext
            ? (asObject(body.selectedContext) as {
                host?: string;
                environment?: string;
                service?: string;
              })
            : undefined,
          model:
            providerId && modelId ? { providerId, modelId } : undefined,
        }),
        201,
      );
    }
    if (method === "GET" && id === "status" && parts.length === 3) {
      return json({ sessions: await product.sessionStatus() });
    }
    if (!id) {
      return json({ ok: false }, 404);
    }

    if (method === "GET" && parts.length === 3) {
      return json(await product.getSession(id));
    }
    if (method === "PATCH" && parts.length === 3) {
      const body = await readJson(request);
      return json(
        await product.patchSession(id, {
          title: typeof body.title === "string" ? body.title : undefined,
          labels: asStringMap(body.labels),
          selectedContext: body.selectedContext
            ? (asObject(body.selectedContext) as {
                host?: string;
                environment?: string;
                service?: string;
              })
            : undefined,
          shareMetadata:
            body.shareMetadata && typeof body.shareMetadata === "object"
              ? (body.shareMetadata as Record<string, unknown>)
              : undefined,
        }),
      );
    }
    if (method === "DELETE" && parts.length === 3) {
      await product.deleteSession(id);
      return json({ ok: true });
    }

    if (method === "POST" && action === "prompt") {
      const parsed = await readPromptBody(request);
      if (!parsed.ok) {
        return promptBodyError(parsed);
      }
      const result = await product.prompt(
        { text: parsed.text, files: parsed.files },
        { thebeSessionId: id, mode: parsed.mode },
      );
      return json({
        text: result.text,
        tools: result.tools,
        thebeSessionId: result.thebeSessionId,
      });
    }
    if (method === "GET" && action === "message" && !extra) {
      const messages = await product.loadMessages(id);
      const limitResult = parseLimit(url.searchParams.get("limit"));
      if (!limitResult.ok) {
        return json({ error: limitResult.error }, 400);
      }
      const after = url.searchParams.get("after");
      let start = 0;
      if (after !== null) {
        const found = messages.findIndex((message) => message.id === after);
        if (found < 0) {
          return json({ error: "unknown message cursor" }, 400);
        }
        start = found + 1;
      }
      const sliced = messages.slice(start, start + limitResult.limit);
      return json({
        messages: sliced,
        total: messages.length,
        hasMore: start + sliced.length < messages.length,
      });
    }
    if (method === "GET" && action === "message" && extra) {
      const message = await product.message(id, extra);
      if (!message) {
        return json({ error: "message not found" }, 404);
      }
      return json(message);
    }
    if (method === "GET" && action === "log") {
      const afterResult = parseLogCursor(request, url);
      if (!afterResult.ok) {
        return json({ error: afterResult.error }, 400);
      }
      if (url.searchParams.get("follow") === "true") {
        return sessionLogStream(product, id, request, afterResult.after);
      }
      const events = product.events(id);
      const sliced = events.slice(afterResult.after);
      return json({ events: sliced, next: events.length });
    }
    if (method === "POST" && action === "interrupt") {
      await product.interrupt(id);
      return json({ ok: true });
    }
    if (method === "POST" && action === "permission" && extra) {
      const body = await readJson(request);
      const response = body.response === "deny" ? "deny" : "allow";
      await product.resolvePermission(id, extra, {
        response,
        remember: Boolean(body.remember),
      });
      return json({ ok: true });
    }
    if (method === "POST" && action === "fork") {
      const body = await readJson(request);
      const messageID =
        typeof body.messageID === "string"
          ? body.messageID
          : typeof body.messageId === "string"
            ? body.messageId
            : undefined;
      return json(await product.fork(id, messageID), 201);
    }
    if (method === "GET" && action === "children") {
      return json({ sessions: await product.children(id) });
    }
    if (method === "POST" && action === "revert") {
      await product.revert(id);
      return json({ ok: true });
    }
    if (method === "POST" && action === "unrevert") {
      await product.unrevert(id);
      return json({ ok: true });
    }
    if (method === "POST" && action === "compact") {
      await product.compact(id);
      return json({ ok: true });
    }
    if (method === "POST" && action === "model") {
      const body = await readJson(request);
      const model = asObject(body.model);
      const providerId =
        typeof model.providerId === "string" ? model.providerId : "";
      const modelId = typeof model.modelId === "string" ? model.modelId : "";
      if (!providerId || !modelId) {
        return json({ error: "model.providerId and model.modelId required" }, 400);
      }
      await product.setModel(id, { providerId, modelId });
      return json({ ok: true });
    }
    if (method === "POST" && action === "thinking") {
      const body = await readJson(request);
      const level = parseThinkingLevel(body.level);
      if (!level) {
        return json(
          {
            error:
              "invalid thinking level; want off, minimal, low, medium, high, xhigh, or max",
          },
          400,
        );
      }
      await product.setThinkingLevel(id, level);
      return json({ ok: true });
    }
    if (method === "GET" && action === "export") {
      const format = url.searchParams.get("format");
      const exported = await product.exportSession(id);
      if (format === "jsonl") {
        return new Response(exported.jsonl, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (format === "html") {
        return new Response(exported.html, {
          headers: { "content-type": "text/html" },
        });
      }
      if (format !== null) {
        return json({ error: "invalid format; want jsonl or html" }, 400);
      }
      return json(exported);
    }
    if (method === "GET" && action === "diff") {
      return json(
        {
          ok: false,
          code: "feature_not_implemented",
          error: "session diff is not implemented",
        },
        501,
      );
    }
    if (action === "share") {
      if (method === "POST") {
        return json(
          await product.patchSession(id, {
            shareMetadata: { shared: true },
          }),
        );
      }
      if (method === "DELETE") {
        return json(
          await product.patchSession(id, {
            shareMetadata: { shared: false },
          }),
        );
      }
    }
    return json({ ok: false }, 404);
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
    const container = CONTAINER_TOOL_NAMES.map((name) => ({
      name,
      description: CONTAINER_TOOL_DESCRIPTIONS[name],
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
    if (!options.product) {
      throw new Error("MCP tools require the Thebe product service");
    }
    return options.product.invokeTool(mapped, asObject(args) ?? {});
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

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
}

function parseMode(value: unknown): PromptMode | undefined {
  if (value === "steer" || value === "followUp" || value === "prompt") {
    return value;
  }
  return undefined;
}

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" &&
    (THINKING_LEVELS as string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

const MAX_MESSAGE_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 200;

function parseLimit(
  value: string | null,
): { ok: true; limit: number } | { ok: false; error: string } {
  if (value === null) {
    return { ok: true, limit: DEFAULT_MESSAGE_LIMIT };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, error: "limit must be a positive integer" };
  }
  return { ok: true, limit: Math.min(parsed, MAX_MESSAGE_LIMIT) };
}

/**
 * Log cursor is a log-index offset. Accepts `?after=` or the standard
 * `Last-Event-ID` header (SSE streams carry `id:` per event). Reconnect
 * strategy: resume the SSE with the last seen id, or refresh messages.
 */
function parseLogCursor(
  request: Request,
  url: URL,
): { ok: true; after: number } | { ok: false; error: string } {
  const raw =
    url.searchParams.get("after") ?? request.headers.get("last-event-id");
  if (raw === null || raw === "") {
    return { ok: true, after: 0 };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { ok: false, error: "after must be a non-negative integer" };
  }
  return { ok: true, after: parsed };
}

type ParsedPromptBody =
  | { ok: true; text: string; mode: PromptMode; files: PromptFile[] }
  | { ok: false; error: string; status?: number };

/** Shared prompt body validation for the session prompt route. */
async function readPromptBody(request: Request): Promise<ParsedPromptBody> {
  const body = await readJson(request);
  const text = typeof body.text === "string" ? body.text : "";
  const mode = body.mode === undefined ? "prompt" : parseMode(body.mode);
  if (!mode) {
    return {
      ok: false,
      error: "invalid mode; want prompt, steer, or followUp",
    };
  }
  const filesResult = parsePromptFiles(body.files);
  if (!filesResult.ok) {
    return filesResult;
  }
  if (!text.trim() && filesResult.files.length === 0) {
    return { ok: false, error: "text or files required" };
  }
  return { ok: true, text, mode, files: filesResult.files };
}

function parsePromptFiles(value: unknown): ParsedPromptBody {
  if (value === undefined) {
    return { ok: true, text: "", mode: "prompt", files: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "files must be an array" };
  }
  if (value.length > MAX_PROMPT_FILES) {
    return {
      ok: false,
      error: `too many files; maximum is ${MAX_PROMPT_FILES}`,
    };
  }
  const files: PromptFile[] = [];
  for (const item of value) {
    const row = asObject(item);
    const mediaType =
      typeof row.mediaType === "string" ? row.mediaType : "";
    const data = typeof row.data === "string" ? row.data : "";
    if (!mediaType || !data) {
      return { ok: false, error: "each file needs mediaType and data" };
    }
    if (!isSupportedPromptFile(mediaType)) {
      return { ok: false, error: `unsupported media type: ${mediaType}` };
    }
    if (estimatedDecodedBytes(data) > MAX_PROMPT_FILE_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `file too large; maximum is ${MAX_PROMPT_FILE_BYTES} bytes decoded`,
      };
    }
    files.push({
      mediaType,
      data,
      filename: typeof row.filename === "string" ? row.filename : undefined,
    });
  }
  return { ok: true, text: "", mode: "prompt", files };
}

function promptBodyError(result: { error: string; status?: number }): Response {
  return json({ error: result.error }, result.status ?? 400);
}

function oauthCallbackInput(body: Record<string, unknown>): string | undefined {
  for (const key of ["url", "redirectUrl", "redirect_uri", "input"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return undefined;
  }
  const state = typeof body.state === "string" ? body.state.trim() : "";
  return state ? `${code}#${state}` : code;
}

function productError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const statusHint =
    error instanceof Error
      ? (error as Error & { status?: unknown }).status
      : undefined;
  if (
    typeof statusHint === "number" &&
    Number.isInteger(statusHint) &&
    statusHint >= 400 &&
    statusHint < 600
  ) {
    return json({ ok: false, error: message }, statusHint);
  }
  const notFound =
    /unknown|no session|not found|ProductStore has no directory/i.test(
      message,
    );
  return json({ ok: false, error: message }, notFound ? 404 : 500);
}

function sessionLogStream(
  product: ThebeProduct,
  thebeSessionId: string,
  request: Request,
  after: number,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let nextId = after;
      const send = (event: NormalizedEvent) => {
        const line =
          `id: ${nextId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        nextId += 1;
        controller.enqueue(encoder.encode(line));
      };
      for (const event of product.events(thebeSessionId).slice(after)) {
        send(event);
      }
      const unsub = product.subscribeLog(thebeSessionId, send);
      const close = () => {
        unsub();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      if (request.signal.aborted) {
        close();
        return;
      }
      request.signal.addEventListener("abort", close, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
