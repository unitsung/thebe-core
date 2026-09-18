import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The HTTP contract is kept next to the router and exposed at runtime so
 * clients can discover the exact API served by this build.  Keeping this as
 * data (rather than a second hand-written HTML document) also makes it cheap
 * to add an operation and have it show up in Swagger UI immediately.
 */
export type OpenApiDocument = {
  openapi: "3.0.3";
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string }>;
  security: Array<Record<string, string[]>>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    schemas: Record<string, Record<string, unknown>>;
  };
};

type Operation = {
  method: string;
  path: string;
  summary: string;
  tag: string;
  response?: number;
  responseContentType?: string;
  requestBody?: Record<string, unknown>;
  parameters?: Array<Record<string, unknown>>;
};

const jsonSchema = { type: "object", additionalProperties: true };
const idParameter = (name = "id") => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});
const queryParameter = (name: string, schema: Record<string, unknown> = { type: "string" }) => ({
  name,
  in: "query",
  required: false,
  schema,
});

const operations: Operation[] = [
  { method: "get", path: "/v1/health", summary: "Health check", tag: "system" },
  { method: "get", path: "/v1/events", summary: "Recent process events", tag: "system" },
  { method: "get", path: "/v1/event", summary: "Recent process events (singular compatibility alias)", tag: "system" },
  { method: "post", path: "/v1/devices", summary: "Register an iOS device", tag: "compatibility", requestBody: { required: true } },
  { method: "post", path: "/v1/messages", summary: "Send a prompt (iOS compatibility endpoint)", tag: "compatibility", requestBody: { required: true } },
  { method: "get", path: "/v1/system/status", summary: "Read maintenance state", tag: "system" },
  { method: "post", path: "/v1/system/quiesce", summary: "Enter maintenance mode", tag: "system" },
  { method: "post", path: "/v1/system/unquiesce", summary: "Leave maintenance mode", tag: "system" },
  { method: "post", path: "/v1/system/reap", summary: "Reap idle sessions", tag: "system" },
  { method: "get", path: "/v1/agent/running", summary: "List running sessions", tag: "system" },
  { method: "get", path: "/v1/capabilities", summary: "List homelab capabilities", tag: "capabilities" },
  { method: "post", path: "/v1/diagnosis", summary: "Run a read-only container diagnosis", tag: "diagnosis", requestBody: { required: true } },
  { method: "get", path: "/v1/diagnosis/{runId}", summary: "Read a diagnosis run", tag: "diagnosis", parameters: [idParameter("runId")] },
  { method: "post", path: "/v1/diagnosis/{runId}/why", summary: "Ask why a diagnosis was reached", tag: "diagnosis", parameters: [idParameter("runId")], requestBody: { required: false } },
  { method: "post", path: "/v1/action", summary: "Execute an approved container.restart", tag: "action", requestBody: { required: true } },
  { method: "get", path: "/v1/action/{receiptId}", summary: "Read an action receipt", tag: "action", parameters: [idParameter("receiptId")] },
  { method: "get", path: "/v1/activity", summary: "List Activity workspace items (approval, receipt, goal)", tag: "activity" },
  { method: "get", path: "/v1/activity/{id}", summary: "Read one Activity workspace item", tag: "activity", parameters: [idParameter()] },
  { method: "post", path: "/v1/activity/{id}/deny", summary: "Reject a pending Approval and remove it from Activity", tag: "activity", parameters: [idParameter()] },
  { method: "post", path: "/v1/goals", summary: "Create a session and start a Goal", tag: "goal", response: 201, requestBody: { required: true } },
  { method: "get", path: "/v1/goals", summary: "List persisted Goals", tag: "goal" },
  { method: "get", path: "/v1/goals/{id}", summary: "Read one Goal (id is thebeSessionId)", tag: "goal", parameters: [idParameter()] },
  { method: "post", path: "/v1/goals/{id}/pause", summary: "Pause a running Goal after the current checkpoint", tag: "goal", parameters: [idParameter()] },
  { method: "post", path: "/v1/goals/{id}/resume", summary: "Resume a paused Goal", tag: "goal", parameters: [idParameter()] },
  { method: "post", path: "/v1/goals/{id}/stop", summary: "Cancel a Goal", tag: "goal", parameters: [idParameter()] },
  { method: "get", path: "/v1/goals/{id}/log", summary: "Read Goal events or follow an SSE log", tag: "goal", parameters: [idParameter(), queryParameter("follow", { type: "boolean" }), queryParameter("after", { type: "integer", minimum: 0 })], responseContentType: "text/event-stream" },
  { method: "get", path: "/v1/session", summary: "List sessions", tag: "session", parameters: [queryParameter("status"), queryParameter("hostId"), queryParameter("environmentId")] },
  { method: "post", path: "/v1/session", summary: "Create a session", tag: "session", response: 201, requestBody: { required: false } },
  { method: "get", path: "/v1/session/status", summary: "List session statuses", tag: "session" },
  { method: "get", path: "/v1/session/{id}", summary: "Get session metadata", tag: "session", parameters: [idParameter()] },
  { method: "patch", path: "/v1/session/{id}", summary: "Update session metadata", tag: "session", parameters: [idParameter()], requestBody: { required: true } },
  { method: "delete", path: "/v1/session/{id}", summary: "Delete a session", tag: "session", parameters: [idParameter()] },
  { method: "get", path: "/v1/session/{id}/children", summary: "List forked children", tag: "session", parameters: [idParameter()] },
  { method: "get", path: "/v1/session/{id}/context", summary: "Get context usage", tag: "session", parameters: [idParameter()] },
  { method: "get", path: "/v1/session/{id}/message", summary: "Read paginated messages", tag: "messages", parameters: [idParameter(), queryParameter("limit", { type: "integer", minimum: 1 }), queryParameter("before"), queryParameter("after")] },
  { method: "get", path: "/v1/session/{id}/message/{messageId}", summary: "Read one message", tag: "messages", parameters: [idParameter(), idParameter("messageId")] },
  { method: "get", path: "/v1/session/{id}/log", summary: "Read events or follow an SSE log", tag: "events", parameters: [idParameter(), queryParameter("follow", { type: "boolean" }), queryParameter("after", { type: "integer", minimum: 0 })], responseContentType: "text/event-stream" },
  { method: "get", path: "/v1/session/{id}/background-task", summary: "List background tasks", tag: "session", parameters: [idParameter()] },
  { method: "post", path: "/v1/session/{id}/background-task/{taskId}/stop", summary: "Stop one background task", tag: "session", parameters: [idParameter(), idParameter("taskId")] },
  { method: "post", path: "/v1/session/{id}/background-task/stop-all", summary: "Stop all background tasks", tag: "session", parameters: [idParameter()] },
  { method: "post", path: "/v1/session/{id}/prompt", summary: "Submit a prompt", tag: "prompt", parameters: [idParameter()], requestBody: { required: true } },
  { method: "post", path: "/v1/session/{id}/interrupt", summary: "Interrupt the current run", tag: "prompt", parameters: [idParameter()] },
  { method: "post", path: "/v1/session/{id}/permission/{permissionId}", summary: "Resolve a permission request", tag: "prompt", parameters: [idParameter(), idParameter("permissionId")], requestBody: { required: true } },
  { method: "post", path: "/v1/session/{id}/tool-call/{toolCallId}/stop", summary: "Stop one tool call", tag: "prompt", parameters: [idParameter(), idParameter("toolCallId")] },
  { method: "post", path: "/v1/session/{id}/compact", summary: "Compact the session", tag: "prompt", parameters: [idParameter()], requestBody: { required: false } },
  { method: "post", path: "/v1/session/{id}/fork", summary: "Fork a session", tag: "session", parameters: [idParameter()], requestBody: { required: false } },
  { method: "post", path: "/v1/session/{id}/revert", summary: "Revert the current branch", tag: "session", parameters: [idParameter()] },
  { method: "post", path: "/v1/session/{id}/unrevert", summary: "Unrevert the current branch", tag: "session", parameters: [idParameter()] },
  { method: "post", path: "/v1/session/{id}/model", summary: "Set session model", tag: "models", parameters: [idParameter()], requestBody: { required: true } },
  { method: "post", path: "/v1/session/{id}/thinking", summary: "Set thinking level", tag: "models", parameters: [idParameter()], requestBody: { required: true } },
  { method: "get", path: "/v1/session/{id}/export", summary: "Export a session", tag: "session", parameters: [idParameter(), queryParameter("format", { type: "string", enum: ["jsonl", "html"] })] },
  { method: "get", path: "/v1/session/{id}/diff", summary: "Get workspace git diff", tag: "session", parameters: [idParameter()] },
  { method: "get", path: "/v1/provider", summary: "List providers", tag: "providers", parameters: [queryParameter("all", { type: "boolean" })] },
  { method: "get", path: "/v1/provider/auth", summary: "List provider auth status", tag: "providers" },
  { method: "get", path: "/v1/model", summary: "List models", tag: "models", parameters: [queryParameter("all", { type: "boolean" }), queryParameter("provider")] },
  { method: "post", path: "/v1/provider/{providerId}/test", summary: "Test a provider", tag: "providers", parameters: [idParameter("providerId")] },
  { method: "post", path: "/v1/provider/{providerId}/api-key", summary: "Set an API key", tag: "providers", parameters: [idParameter("providerId")], requestBody: { required: true } },
  { method: "delete", path: "/v1/provider/{providerId}/api-key", summary: "Delete an API key", tag: "providers", parameters: [idParameter("providerId")] },
  { method: "get", path: "/v1/provider/{providerId}/oauth/login", summary: "Start OAuth login (SSE)", tag: "providers", parameters: [idParameter("providerId")], responseContentType: "text/event-stream" },
  { method: "post", path: "/v1/provider/{providerId}/oauth/authorize", summary: "Authorize OAuth", tag: "providers", parameters: [idParameter("providerId")] },
  { method: "post", path: "/v1/provider/{providerId}/oauth/callback", summary: "Submit OAuth callback", tag: "providers", parameters: [idParameter("providerId")], requestBody: { required: true } },
  { method: "post", path: "/v1/provider/{providerId}/oauth/login", summary: "Submit OAuth callback (compatibility alias)", tag: "providers", parameters: [idParameter("providerId")], requestBody: { required: true } },
  { method: "post", path: "/v1/provider/{providerId}/oauth/logout", summary: "Logout OAuth", tag: "providers", parameters: [idParameter("providerId")] },
  { method: "delete", path: "/v1/provider/{providerId}/oauth/logout", summary: "Logout OAuth", tag: "providers", parameters: [idParameter("providerId")] },
  { method: "post", path: "/v1/auth", summary: "Set an API key (compatibility endpoint)", tag: "providers", requestBody: { required: true } },
  { method: "put", path: "/v1/auth/{providerId}", summary: "Set an API key (compatibility endpoint)", tag: "providers", parameters: [idParameter("providerId")], requestBody: { required: true } },
  { method: "delete", path: "/v1/auth/{providerId}", summary: "Logout provider (compatibility endpoint)", tag: "providers", parameters: [idParameter("providerId")] },
  { method: "post", path: "/mcp", summary: "MCP JSON-RPC endpoint", tag: "mcp", requestBody: { required: true } },
];

export function createOpenApiDocument(version: string): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const operation of operations) {
    const path = (paths[operation.path] ??= {});
    path[operation.method] = {
      summary: operation.summary,
      operationId: `${operation.method}_${operation.path.replaceAll(/[{}\/]/g, "_").replaceAll(/_+/g, "_")}`,
      tags: [operation.tag],
      parameters: operation.parameters,
      requestBody: operation.requestBody
        ? { ...operation.requestBody, content: { "application/json": { schema: jsonSchema } } }
        : undefined,
      responses: {
        [String(operation.response ?? 200)]: {
          description: operation.response === 501 ? "Feature is not available" : "Successful response",
          content: {
            [operation.responseContentType ?? "application/json"]: {
              schema: operation.responseContentType === "text/event-stream" ? { type: "string" } : jsonSchema,
            },
          },
        },
        "400": { description: "Invalid request" },
        "401": { description: "Missing or invalid token" },
        "404": { description: "Resource not found" },
        "409": { description: "Session is busy" },
        "503": { description: "Service unavailable or quiesced" },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "Thebe Core HTTP API",
      version,
      description: "Thebe Core session, prompt, runtime, provider, and MCP API. The JSON document is generated by the running server.",
    },
    servers: [{ url: "/" }],
    // Token auth is optional in development and required in production; the
    // empty requirement keeps both deployment modes accurately documented.
    security: [{}, { ThebeToken: [] }],
    tags: [
      { name: "system", description: "Health and lifecycle controls" },
      { name: "session", description: "Session lifecycle and metadata" },
      { name: "messages", description: "Runtime transcript messages" },
      { name: "events", description: "Normalized events and SSE logs" },
      { name: "prompt", description: "Prompt execution and approvals" },
      { name: "models", description: "Model selection" },
      { name: "providers", description: "Provider discovery and authentication" },
      { name: "capabilities", description: "Homelab capability and plugin discovery" },
      { name: "diagnosis", description: "Product-facing read-only diagnosis; App does not call raw MCP tools" },
      { name: "action", description: "Approved write actions (container.restart) with deterministic verification receipts" },
      { name: "activity", description: "Minimal persisted ActionReceipt records; not a Goal/Run system" },
      { name: "goal", description: "Durable ProductGoal attached to one parent session. Identity is thebeSessionId (id === sessionId). Runtime pausing collapses to running. Session-scoped aliases live under /v1/session/{id}/goal*." },
      { name: "compatibility", description: "Legacy iOS compatibility endpoints" },
      { name: "mcp", description: "MCP JSON-RPC" },
    ],
    paths,
    components: {
      securitySchemes: {
        ThebeToken: { type: "apiKey", in: "header", name: "X-Thebe-Token" },
      },
      schemas: {
        Error: {
          type: "object",
          properties: { ok: { type: "boolean" }, error: { type: "string" }, code: { type: "string" } },
        },
        ProductGoal: {
          type: "object",
          description: "Product-facing Goal. id and sessionId are the parent thebeSessionId.",
          properties: {
            id: { type: "string" },
            sessionId: { type: "string" },
            title: { type: "string" },
            status: { type: "string", enum: ["queued", "running", "paused", "succeeded", "failed", "cancelled"] },
            phase: { type: "string" },
            progress: { type: "number" },
            currentStep: { type: "string" },
            iteration: { type: "integer" },
            maxIterations: { type: "integer" },
            criteria: { type: "array", items: { type: "string" } },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
            finishedAt: { type: "string" },
            summary: { type: "string" },
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                retryable: { type: "boolean" },
              },
            },
            controls: {
              type: "object",
              properties: {
                pause: { type: "boolean" },
                resume: { type: "boolean" },
                stop: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  };
}

export function swaggerUiHtml(version: string): string {
  const safeVersion = version.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
  const title = `Thebe Core API ${safeVersion}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script>
<script src="/docs/swagger-ui-init.js"></script></body></html>`;
}

const require = createRequire(import.meta.url);
const swaggerUiDirectory = dirname(require.resolve("swagger-ui-dist/package.json"));
const swaggerUiInitScript =
  "window.ui=SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true,persistAuthorization:true});";
const swaggerAssets: Record<string, { file: string; contentType: string }> = {
  "/docs/swagger-ui.css": { file: "swagger-ui.css", contentType: "text/css; charset=utf-8" },
  "/docs/swagger-ui-bundle.js": { file: "swagger-ui-bundle.js", contentType: "text/javascript; charset=utf-8" },
  "/docs/swagger-ui-standalone-preset.js": { file: "swagger-ui-standalone-preset.js", contentType: "text/javascript; charset=utf-8" },
  "/docs/favicon-32x32.png": { file: "favicon-32x32.png", contentType: "image/png" },
  "/docs/favicon-16x16.png": { file: "favicon-16x16.png", contentType: "image/png" },
};

/** Serve only the known Swagger UI assets; arbitrary filesystem paths are never accepted. */
export function swaggerUiAsset(path: string): Response | undefined {
  if (path === "/docs/swagger-ui-init.js") {
    return new Response(swaggerUiInitScript, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=86400, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const asset = swaggerAssets[path];
  if (!asset) return undefined;
  return new Response(readFileSync(join(swaggerUiDirectory, asset.file)), {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
