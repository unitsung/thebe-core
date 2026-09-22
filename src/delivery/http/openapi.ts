import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { HOMELAB_CAPABILITY_CATEGORIES } from "../../agent/extensions/mcp.ts";
import { PRODUCT_HTTP_PATH, PRODUCT_HTTP_SEGMENT } from "./product-paths.ts";

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
  requestSchema?: string;
  responseSchema?: string;
  extraStatuses?: Array<{ status: number; description: string; schema?: string }>;
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
  { method: "get", path: "/v1/devices", summary: "List registered iOS devices", tag: "compatibility", responseSchema: "DeviceRegistrationList" },
  { method: "post", path: "/v1/devices", summary: "Register an iOS device", tag: "compatibility", requestBody: { required: true }, requestSchema: "DeviceRegistrationRequest", responseSchema: "DeviceRegistration" },
  { method: "delete", path: "/v1/devices/{registrationId}", summary: "Remove a registered iOS device", tag: "compatibility", parameters: [idParameter("registrationId")], responseSchema: "Ok" },
  { method: "post", path: "/v1/messages", summary: "Send a prompt (iOS compatibility endpoint)", tag: "compatibility", requestBody: { required: true } },
  { method: "get", path: "/v1/system/status", summary: "Read maintenance state", tag: "system" },
  { method: "post", path: "/v1/system/quiesce", summary: "Enter maintenance mode", tag: "system" },
  { method: "post", path: "/v1/system/unquiesce", summary: "Leave maintenance mode", tag: "system" },
  { method: "post", path: "/v1/system/reap", summary: "Reap idle sessions", tag: "system" },
  { method: "get", path: "/v1/agent/running", summary: "List running sessions", tag: "system" },
  { method: "get", path: PRODUCT_HTTP_PATH.capabilities, summary: "List homelab capabilities", tag: "capabilities", responseSchema: "CapabilityList" },
  { method: "get", path: PRODUCT_HTTP_PATH.audit, summary: "Read the redacted append-only audit log", tag: "audit", parameters: [queryParameter("limit", { type: "integer", minimum: 1, maximum: 200, default: 100 }), queryParameter("cursor", { type: "string" }), queryParameter("sessionId"), queryParameter("method"), queryParameter("result", { type: "string", enum: ["ok", "error", "denied"] })], responseSchema: "AuditList" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.audit}/{id}`, summary: "Read one redacted audit record", tag: "audit", parameters: [idParameter()], responseSchema: "AuditRecord" },
  { method: "post", path: `${PRODUCT_HTTP_PATH.capabilities}/{id}/${PRODUCT_HTTP_SEGMENT.invoke}`, summary: "Invoke a capability through ThebeAgent", tag: "capabilities", parameters: [idParameter()], requestBody: { required: true }, requestSchema: "CapabilityInvokeRequest", responseSchema: "CapabilityInvokeResult", extraStatuses: [{ status: 202, description: "Background run started", schema: "CapabilityInvokeResult" }, { status: 403, description: "Write requires POST /v1/action" }] },
  { method: "get", path: `${PRODUCT_HTTP_PATH.capabilities}/${PRODUCT_HTTP_SEGMENT.runs}`, summary: "List persisted background capability runs", tag: "capabilities", responseSchema: "CapabilityRunList" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.capabilities}/${PRODUCT_HTTP_SEGMENT.runs}/{runId}`, summary: "Read a background capability run", tag: "capabilities", parameters: [idParameter("runId")], responseSchema: "CapabilityRun" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.capabilities}/${PRODUCT_HTTP_SEGMENT.runs}/{runId}/${PRODUCT_HTTP_SEGMENT.log}`, summary: "Follow a background capability run over SSE", tag: "capabilities", parameters: [idParameter("runId")], responseSchema: "CapabilityRun", responseContentType: "text/event-stream" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.subagents}/${PRODUCT_HTTP_SEGMENT.profiles}`, summary: "List subagent profiles", tag: "workers", responseSchema: "SubagentProfileList" },
  { method: "get", path: PRODUCT_HTTP_PATH.subagents, summary: "List subagent runs", tag: "workers", parameters: [queryParameter("parentSessionId")], responseSchema: "WorkerList" },
  { method: "post", path: PRODUCT_HTTP_PATH.subagents, summary: "Spawn a subagent worker", tag: "workers", response: 201, requestBody: { required: true }, requestSchema: "SpawnWorkerRequest", responseSchema: "ProductWorker" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.subagents}/{runId}`, summary: "Inspect one subagent run", tag: "workers", parameters: [idParameter("runId")], responseSchema: "ProductWorker" },
  { method: "post", path: `${PRODUCT_HTTP_PATH.subagents}/{runId}/${PRODUCT_HTTP_SEGMENT.cancel}`, summary: "Cancel a subagent run", tag: "workers", parameters: [idParameter("runId")], responseSchema: "ProductWorker" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.subagents}/{runId}/${PRODUCT_HTTP_SEGMENT.log}`, summary: "Read worker activity or follow its SSE log without the parent transcript", tag: "workers", parameters: [idParameter("runId")], responseSchema: "WorkerLog", responseContentType: "text/event-stream" },
  { method: "get", path: PRODUCT_HTTP_PATH.permissions, summary: "List runtime pending permissions (not Activity Approvals)", tag: "permissions", responseSchema: "PendingPermissionList" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.permissions}/{id}`, summary: "Read one pending permission with redacted input", tag: "permissions", parameters: [idParameter()], responseSchema: "PendingPermission" },
  { method: "post", path: `${PRODUCT_HTTP_PATH.permissions}/{id}/${PRODUCT_HTTP_SEGMENT.resolve}`, summary: "Approve or deny a pending permission", tag: "permissions", parameters: [idParameter()], requestBody: { required: true }, requestSchema: "PermissionResolution", responseSchema: "Ok" },
  { method: "get", path: PRODUCT_HTTP_PATH.skills, summary: "List skills", tag: "skills", responseSchema: "SkillList" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.skills}/{name}`, summary: "Get skill metadata", tag: "skills", parameters: [idParameter("name")], responseSchema: "Skill" },
  { method: "patch", path: `${PRODUCT_HTTP_PATH.skills}/{name}`, summary: "Enable or disable a skill", tag: "skills", parameters: [idParameter("name")], requestBody: { required: true }, requestSchema: "SkillPatch", responseSchema: "Skill" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.mcpExtensions}/${PRODUCT_HTTP_SEGMENT.servers}`, summary: "List MCP servers", tag: "extensions", responseSchema: "McpServerList" },
  { method: "patch", path: `${PRODUCT_HTTP_PATH.mcpExtensions}/${PRODUCT_HTTP_SEGMENT.servers}/{name}`, summary: "Enable or disable an MCP server", tag: "extensions", parameters: [idParameter("name")], requestBody: { required: true }, requestSchema: "McpServerPatch", responseSchema: "McpServer" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.mcpExtensions}/${PRODUCT_HTTP_SEGMENT.tools}`, summary: "List external MCP tools", tag: "extensions", responseSchema: "McpToolList" },
  { method: "get", path: PRODUCT_HTTP_PATH.enabledResources, summary: "List enabled Agent resources", tag: "resources", responseSchema: "EnabledResourceList" },
  { method: "post", path: `${PRODUCT_HTTP_PATH.enabledResources}/artifact`, summary: "Capture enabled resources as an Artifact", tag: "resources", responseSchema: "AgentArtifact" },
  { method: "put", path: `${PRODUCT_HTTP_PATH.enabledResources}/{id}`, summary: "Put an enabled resource", tag: "resources", parameters: [idParameter()], requestBody: { required: true }, requestSchema: "EnabledResourceWrite", responseSchema: "EnabledResource" },
  { method: "delete", path: `${PRODUCT_HTTP_PATH.enabledResources}/{id}`, summary: "Remove an enabled resource", tag: "resources", parameters: [idParameter()], responseSchema: "Ok" },
  { method: "get", path: PRODUCT_HTTP_PATH.artifacts, summary: "List bounded product Artifacts", tag: "artifacts", parameters: [queryParameter("kind", { type: "string", enum: ["diagnosis", "report", "resource_list", "operation_receipt"] }), queryParameter("sessionId"), queryParameter("runId"), queryParameter("createdAfter"), queryParameter("createdBefore"), queryParameter("limit", { type: "integer", minimum: 1, maximum: 100 })], responseSchema: "ArtifactList" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.artifacts}/{id}`, summary: "Read Artifact metadata", tag: "artifacts", parameters: [idParameter()], responseSchema: "AgentArtifact" },
  { method: "get", path: `${PRODUCT_HTTP_PATH.artifacts}/{id}/content`, summary: "Read bounded Artifact content", tag: "artifacts", parameters: [idParameter()], responseSchema: "ArtifactContent" },
  { method: "get", path: PRODUCT_HTTP_PATH.permissionSettings, summary: "Read permission mode", tag: "settings", responseSchema: "PermissionModeSettings" },
  { method: "patch", path: PRODUCT_HTTP_PATH.permissionSettings, summary: "Set permission mode", tag: "settings", requestBody: { required: true }, requestSchema: "PermissionModeSettings", responseSchema: "PermissionModeSettings" },
  { method: "get", path: PRODUCT_HTTP_PATH.agentSettings, summary: "Read effective Agent settings", tag: "settings", responseSchema: "AgentSettings" },
  { method: "patch", path: PRODUCT_HTTP_PATH.agentSettings, summary: "Update mutable Agent settings", tag: "settings", requestBody: { required: true }, requestSchema: "AgentSettingsPatch", responseSchema: "AgentSettings", extraStatuses: [{ status: 409, description: "A setting requires a Core restart" }] },
  { method: "post", path: "/v1/diagnosis", summary: "Run a read-only container diagnosis", tag: "diagnosis", requestBody: { required: true }, responseSchema: "DiagnosisResult" },
  { method: "get", path: "/v1/diagnosis/{runId}", summary: "Read a diagnosis run", tag: "diagnosis", parameters: [idParameter("runId")], responseSchema: "DiagnosisResult" },
  { method: "post", path: "/v1/diagnosis/{runId}/why", summary: "Ask why a diagnosis was reached", tag: "diagnosis", parameters: [idParameter("runId")], requestBody: { required: false }, responseSchema: "DiagnosisResult" },
  { method: "post", path: "/v1/action", summary: "Execute an approved container.restart", tag: "action", requestBody: { required: true } },
  { method: "get", path: "/v1/action/{receiptId}", summary: "Read an action receipt", tag: "action", parameters: [idParameter("receiptId")] },
  { method: "get", path: "/v1/activity", summary: "List Activity workspace items (approval, receipt, goal, run, worker, background task)", tag: "activity", parameters: [queryParameter("group", { type: "string", enum: ["needs_approval", "running", "recent"] }), queryParameter("source", { type: "string", enum: ["approval", "receipt", "goal", "run", "worker", "background_task"] }), queryParameter("status"), queryParameter("updatedAfter", { type: "string", format: "date-time" }), queryParameter("updatedBefore", { type: "string", format: "date-time" }), queryParameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 }), queryParameter("cursor")], responseSchema: "ActivityList" },
  { method: "get", path: "/v1/activity/{id}", summary: "Read one Activity workspace item", tag: "activity", parameters: [idParameter()], responseSchema: "ActivityItem" },
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

function schemaRef(name?: string): Record<string, unknown> {
  return name ? { $ref: `#/components/schemas/${name}` } : jsonSchema;
}

export function createOpenApiDocument(version: string): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const operation of operations) {
    const path = (paths[operation.path] ??= {});
    const successStatus = String(operation.response ?? 200);
    const responses: Record<string, unknown> = {
      [successStatus]: {
        description: operation.response === 501 ? "Feature is not available" : "Successful response",
        content: {
          [operation.responseContentType ?? "application/json"]: {
            schema: operation.responseContentType === "text/event-stream"
              ? { type: "string" }
              : schemaRef(operation.responseSchema),
          },
        },
      },
      "400": { description: "Invalid request" },
      "401": { description: "Missing or invalid token" },
      "404": { description: "Resource not found" },
      "409": { description: "Session is busy" },
      "503": { description: "Service unavailable or quiesced" },
    };
    for (const extra of operation.extraStatuses ?? []) {
      responses[String(extra.status)] = {
        description: extra.description,
        ...(extra.schema
          ? { content: { "application/json": { schema: schemaRef(extra.schema) } } }
          : {}),
      };
    }
    path[operation.method] = {
      summary: operation.summary,
      operationId: `${operation.method}_${operation.path.replaceAll(/[{}\/]/g, "_").replaceAll(/_+/g, "_")}`,
      tags: [operation.tag],
      parameters: operation.parameters,
      requestBody: operation.requestBody
        ? {
            ...operation.requestBody,
            content: { "application/json": { schema: schemaRef(operation.requestSchema) } },
          }
        : undefined,
      responses,
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
      { name: "capabilities", description: "Homelab capability discovery and Agent-mediated invoke" },
      { name: "audit", description: "Read-only redacted audit records; raw parameters are never returned" },
      { name: "workers", description: "Subagent runs presented as Workers; no parent transcript" },
      { name: "permissions", description: "Runtime pending tool permissions. Distinct from Activity diagnose-restart Approvals." },
      { name: "skills", description: "Skill list/get/enable; no skill-file editing" },
      { name: "extensions", description: "Product MCP inventory; raw /mcp remains for integrations" },
      { name: "resources", description: "Enabled Agent resources/context, not a Resource database" },
      { name: "artifacts", description: "Bounded, redacted product results owned by Core" },
      { name: "settings", description: "Runtime behavior settings consumed by the App" },
      { name: "diagnosis", description: "Product-facing read-only diagnosis; App does not call raw MCP tools" },
      { name: "action", description: "Approved write actions (container.restart) with deterministic verification receipts" },
      { name: "activity", description: "Typed Approval, Receipt, Goal, Capability Run, Worker, and Background Task items; lifecycle remains owned by each source object" },
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
        Ok: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
        AuditRecord: {
          type: "object",
          required: ["id", "timestamp", "method", "parameterHash", "responseBytes", "budgetConsumed", "redactionFired"],
          properties: {
            id: { type: "string" },
            timestamp: { type: "string" },
            method: { type: "string" },
            parameterHash: { type: "string" },
            responseBytes: { type: "number" },
            budgetConsumed: { type: "number" },
            redactionFired: { type: "boolean" },
            identity: { type: "string" },
            version: { type: "string" },
            source: { type: "string" },
            sessionId: { type: "string" },
            result: { type: "string", enum: ["ok", "error", "denied"] },
            durationMs: { type: "number" },
          },
        },
        AuditList: {
          type: "object",
          required: ["entries"],
          properties: {
            entries: { type: "array", items: { $ref: "#/components/schemas/AuditRecord" } },
            nextCursor: { type: "string" },
          },
        },
        HomelabCapability: {
          type: "object",
          required: ["id", "name", "description", "inputSchema", "category", "permission", "source"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            inputSchema: { type: "object", additionalProperties: true },
            category: { type: "string", enum: [...HOMELAB_CAPABILITY_CATEGORIES] },
            permission: { type: "string", enum: ["read", "confirm", "admin"] },
            effect: { type: "string", enum: ["read", "write"] },
            risk: { type: "string", enum: ["low", "disruptive"] },
            approval: { type: "string", enum: ["none", "required"] },
            service: { type: "string" },
            source: { type: "string", enum: ["core", "external"] },
            serverName: { type: "string" },
            resourceKinds: { type: "array", items: { type: "string" } },
            execution: { type: "string", enum: ["direct", "agent", "goal", "either"] },
            background: { type: "boolean" },
            destructive: { type: "boolean" },
            outputKind: { type: "string" },
          },
        },
        CapabilityList: {
          type: "object",
          required: ["capabilities"],
          properties: {
            capabilities: { type: "array", items: { $ref: "#/components/schemas/HomelabCapability" } },
          },
        },
        CapabilityInvokeRequest: {
          type: "object",
          properties: {
            arguments: { type: "object", additionalProperties: true },
            mode: { type: "string", enum: ["direct", "background"] },
            resource: { type: "object", additionalProperties: true },
          },
        },
        CapabilityInvokeResult: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["result", "run"] },
            result: { description: "Direct invoke payload", nullable: true },
            runId: { type: "string" },
          },
        },
        CapabilityRun: {
          type: "object",
          required: ["runId", "capabilityId", "status", "createdAt"],
          properties: {
            runId: { type: "string" },
            capabilityId: { type: "string" },
            status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "interrupted"] },
            artifactId: { type: "string" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
            finishedAt: { type: "string" },
            resource: { type: "object", additionalProperties: true },
            result: { description: "Direct invoke payload", nullable: true },
            error: { type: "string" },
          },
        },
        CapabilityRunList: {
          type: "object",
          required: ["runs"],
          properties: {
            runs: { type: "array", items: { $ref: "#/components/schemas/CapabilityRun" } },
          },
        },
        DiagnosisResult: {
          type: "object",
          required: ["runId", "actionId", "status", "resource", "observations", "diagnosis", "recommendations", "technicalDetails"],
          properties: {
            runId: { type: "string" },
            artifactId: { type: "string" },
            actionId: { type: "string", enum: ["container.diagnose"] },
            status: { type: "string", enum: ["completed", "failed", "provider_unavailable", "insufficient_data"] },
            resource: { type: "object", additionalProperties: true },
            observations: { type: "array", items: { type: "object", additionalProperties: true } },
            diagnosis: { type: "object", additionalProperties: true },
            recommendations: { type: "array", items: { type: "object", additionalProperties: true } },
            technicalDetails: { type: "object", additionalProperties: true },
            error: { type: "string" },
            sessionId: { type: "string" },
            approvalId: { type: "string" },
          },
        },
        ActivityApprovalItem: {
          type: "object",
          required: ["type", "id", "group", "updatedAt", "approval"],
          properties: {
            type: { type: "string", enum: ["approval"] },
            id: { type: "string" },
            group: { type: "string", enum: ["needs_approval"] },
            updatedAt: { type: "string" },
            approval: { type: "object", additionalProperties: true },
          },
        },
        ActivityReceiptItem: {
          type: "object",
          required: ["type", "id", "group", "updatedAt", "receipt"],
          properties: {
            type: { type: "string", enum: ["receipt"] },
            id: { type: "string" },
            group: { type: "string", enum: ["running", "recent"] },
            updatedAt: { type: "string" },
            receipt: { type: "object", additionalProperties: true },
          },
        },
        ActivityGoalItem: {
          type: "object",
          required: ["type", "id", "group", "updatedAt", "goal"],
          properties: {
            type: { type: "string", enum: ["goal"] },
            id: { type: "string" },
            group: { type: "string", enum: ["running", "recent"] },
            updatedAt: { type: "string" },
            goal: { type: "object", additionalProperties: true },
          },
        },
        ActivityRunItem: {
          type: "object",
          required: ["type", "id", "group", "updatedAt", "run"],
          properties: {
            type: { type: "string", enum: ["run"] },
            id: { type: "string" },
            group: { type: "string", enum: ["running", "recent"] },
            updatedAt: { type: "string" },
            run: { $ref: "#/components/schemas/CapabilityRun" },
          },
        },
        ActivityWorkerItem: {
          type: "object",
          required: ["type", "id", "group", "updatedAt", "worker"],
          properties: {
            type: { type: "string", enum: ["worker"] },
            id: { type: "string" },
            group: { type: "string", enum: ["running", "recent"] },
            updatedAt: { type: "string" },
            worker: { $ref: "#/components/schemas/ProductWorker" },
          },
        },
        ActivityBackgroundTaskItem: {
          type: "object",
          required: ["type", "id", "group", "updatedAt", "task"],
          properties: {
            type: { type: "string", enum: ["background_task"] },
            id: { type: "string" },
            group: { type: "string", enum: ["running", "recent"] },
            updatedAt: { type: "string" },
            task: { $ref: "#/components/schemas/ProductBackgroundTask" },
          },
        },
        ActivityItem: {
          oneOf: [
            { $ref: "#/components/schemas/ActivityApprovalItem" },
            { $ref: "#/components/schemas/ActivityReceiptItem" },
            { $ref: "#/components/schemas/ActivityGoalItem" },
            { $ref: "#/components/schemas/ActivityRunItem" },
            { $ref: "#/components/schemas/ActivityWorkerItem" },
            { $ref: "#/components/schemas/ActivityBackgroundTaskItem" },
          ],
        },
        ActivityList: {
          type: "object",
          required: ["items"],
          properties: {
            items: { type: "array", items: { $ref: "#/components/schemas/ActivityItem" } },
            nextCursor: { type: "string" },
          },
        },
        ProductWorker: {
          type: "object",
          required: ["runId", "parentSessionId", "profileName", "task", "status"],
          properties: {
            runId: { type: "string" },
            parentSessionId: { type: "string" },
            profileName: { type: "string" },
            task: { type: "string" },
            status: { type: "string", enum: ["queued", "running", "completed", "failed", "cancelled", "interrupted"] },
            turns: { type: "integer" },
            maxTurns: { type: "integer" },
            createdAt: { type: "string" },
            startedAt: { type: "string" },
            finishedAt: { type: "string" },
            artifactId: { type: "string" },
            responseText: { type: "string" },
            activity: { type: "array", items: { type: "object", additionalProperties: true } },
            result: { type: "string" },
            error: { type: "string" },
          },
        },
        ProductBackgroundTask: {
          type: "object",
          required: ["id", "sessionId", "status", "updatedAt"],
          properties: {
            id: { type: "string" },
            sessionId: { type: "string" },
            name: { type: "string" },
            pid: { type: "integer" },
            port: { type: "integer" },
            status: { type: "string", enum: ["running", "stopped", "failed"] },
            startedAt: { type: "string" },
            finishedAt: { type: "string" },
            updatedAt: { type: "string" },
          },
        },
        ProductSubagentProfile: {
          type: "object",
          required: ["name", "description", "scope"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            scope: { type: "string", enum: ["project", "global", "builtin"] },
            tools: { type: "array", items: { type: "string" } },
            maxTurns: { type: "integer" },
          },
        },
        SubagentProfileList: {
          type: "object",
          required: ["profiles"],
          properties: {
            profiles: { type: "array", items: { $ref: "#/components/schemas/ProductSubagentProfile" } },
          },
        },
        WorkerList: {
          type: "object",
          required: ["subagents"],
          properties: {
            subagents: { type: "array", items: { $ref: "#/components/schemas/ProductWorker" } },
          },
        },
        WorkerLog: {
          type: "object",
          required: ["activity"],
          properties: {
            activity: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
        SpawnWorkerRequest: {
          type: "object",
          required: ["profileName", "parentSessionId"],
          properties: {
            profileName: { type: "string" },
            task: { type: "string" },
            taskPrompt: { type: "string" },
            parentSessionId: { type: "string" },
          },
        },
        DeviceRegistration: {
          type: "object",
          required: ["registrationId", "platform", "categories", "registeredAt", "updatedAt"],
          properties: {
            registrationId: { type: "string" },
            platform: { type: "string", enum: ["ios"] },
            deviceId: { type: "string" },
            categories: { type: "array", items: { type: "string" } },
            registeredAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        DeviceRegistrationList: {
          type: "object",
          required: ["devices"],
          properties: {
            devices: { type: "array", items: { $ref: "#/components/schemas/DeviceRegistration" } },
          },
        },
        DeviceRegistrationRequest: {
          type: "object",
          required: ["token", "platform"],
          properties: {
            token: { type: "string", maxLength: 512, writeOnly: true },
            platform: { type: "string", enum: ["ios"] },
            deviceId: { type: "string" },
            categories: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 64 } },
          },
        },
        PendingPermission: {
          type: "object",
          required: ["id", "sessionId", "toolName", "title", "requestedAt", "rememberScopes"],
          properties: {
            id: { type: "string" },
            sessionId: { type: "string" },
            toolName: { type: "string" },
            title: { type: "string" },
            reason: { type: "string" },
            input: { description: "Redacted tool arguments", nullable: true },
            argsSummary: { type: "string" },
            requestedAt: { type: "string" },
            rememberScopes: { type: "array", items: { type: "string", enum: ["request", "tool", "conversation"] } },
            risk: { type: "string", enum: ["high", "standard"] },
          },
        },
        PendingPermissionList: {
          type: "object",
          required: ["permissions"],
          properties: {
            permissions: { type: "array", items: { $ref: "#/components/schemas/PendingPermission" } },
          },
        },
        PermissionResolution: {
          type: "object",
          required: ["response"],
          properties: {
            response: { type: "string", enum: ["allow", "deny"] },
            remember: { type: "boolean" },
            rememberScope: { type: "string", enum: ["request", "tool", "conversation"] },
          },
        },
        Skill: {
          type: "object",
          required: ["name", "description", "scope", "enabled"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            scope: { type: "string", enum: ["project", "global", "builtin"] },
            enabled: { type: "boolean" },
          },
        },
        SkillList: {
          type: "object",
          required: ["skills"],
          properties: {
            skills: { type: "array", items: { $ref: "#/components/schemas/Skill" } },
          },
        },
        SkillPatch: {
          type: "object",
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
        McpServer: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            command: { type: "string" },
            url: { type: "string" },
            service: { type: "string" },
            status: { type: "string" },
            error: { type: "string" },
            toolCount: { type: "integer" },
            disabled: { type: "boolean" },
          },
        },
        McpServerPatch: {
          type: "object",
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
        McpTool: {
          type: "object",
          description: "External MCP tool. Same shape as HomelabCapability with source=external.",
          required: ["id", "name", "source"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            source: { type: "string", enum: ["external"] },
            serverName: { type: "string" },
            category: { type: "string" },
            permission: { type: "string" },
            inputSchema: { type: "object", additionalProperties: true },
          },
        },
        McpServerList: {
          type: "object",
          required: ["servers"],
          properties: {
            servers: { type: "array", items: { $ref: "#/components/schemas/McpServer" } },
          },
        },
        McpToolList: {
          type: "object",
          required: ["tools"],
          properties: {
            tools: { type: "array", items: { $ref: "#/components/schemas/McpTool" } },
          },
        },
        EnabledResource: {
          type: "object",
          required: ["identity", "version", "source", "kind"],
          properties: {
            identity: { type: "string" },
            version: { type: "string" },
            source: { type: "string" },
            kind: { type: "string", enum: ["skill", "extension", "prompt"] },
          },
        },
        EnabledResourceWrite: {
          type: "object",
          required: ["kind", "version", "source"],
          properties: {
            kind: { type: "string", enum: ["skill", "extension", "prompt"] },
            version: { type: "string" },
            source: { type: "string" },
          },
        },
        EnabledResourceList: {
          type: "object",
          required: ["resources"],
          properties: {
            resources: { type: "array", items: { $ref: "#/components/schemas/EnabledResource" } },
          },
        },
        AgentArtifact: {
          type: "object",
          required: ["artifactId", "kind", "title", "createdAt", "updatedAt", "contentType", "sizeBytes"],
          properties: {
            artifactId: { type: "string" },
            kind: { type: "string", enum: ["diagnosis", "report", "resource_list", "operation_receipt"] },
            title: { type: "string" },
            sessionId: { type: "string" },
            runId: { type: "string" },
            resource: {
              type: "object",
              required: ["kind", "id"],
              properties: { kind: { type: "string" }, id: { type: "string" } },
            },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
            contentType: { type: "string" },
            sizeBytes: { type: "integer", minimum: 0 },
          },
        },
        ArtifactList: {
          type: "object",
          required: ["artifacts"],
          properties: {
            artifacts: { type: "array", items: { $ref: "#/components/schemas/AgentArtifact" } },
          },
        },
        ArtifactContent: {
          type: "object",
          required: ["artifact", "content"],
          properties: {
            artifact: { $ref: "#/components/schemas/AgentArtifact" },
            content: { type: "string" },
          },
        },
        PermissionModeSettings: {
          type: "object",
          required: ["mode"],
          properties: {
            mode: { type: "string", enum: ["ask", "read-only", "full-access"] },
          },
        },
        AgentSettings: {
          type: "object",
          required: [
            "autoCompact",
            "autoSummary",
            "autoSummaryDelayMs",
            "permissionMode",
            "maxSubagentConcurrency",
            "maxSubagentsPerParent",
            "sources",
            "persistence",
            "mutable",
          ],
          properties: {
            autoCompact: { type: "boolean" },
            autoSummary: { type: "boolean" },
            autoSummaryDelayMs: { type: "integer", minimum: 60000, maximum: 900000 },
            permissionMode: { type: "string", enum: ["ask", "read-only", "full-access"] },
            maxSubagentConcurrency: { type: "integer", minimum: 1, maximum: 16 },
            maxSubagentsPerParent: { type: "integer", minimum: 1, maximum: 16 },
            workspacePath: { type: "string" },
            outputDirectory: { type: "string" },
            sources: {
              type: "object",
              required: [
                "autoCompact",
                "autoSummary",
                "autoSummaryDelayMs",
                "permissionMode",
                "maxSubagentConcurrency",
                "maxSubagentsPerParent",
                "workspacePath",
                "outputDirectory",
              ],
              properties: {
                autoCompact: { type: "string", enum: ["configured", "default", "environment", "derived"] },
                autoSummary: { type: "string", enum: ["configured", "default", "environment", "derived"] },
                autoSummaryDelayMs: { type: "string", enum: ["configured", "default", "environment", "derived"] },
                permissionMode: { type: "string", enum: ["configured", "default", "environment", "derived"] },
                maxSubagentConcurrency: { type: "string", enum: ["configured", "default", "environment", "derived"] },
                maxSubagentsPerParent: { type: "string", enum: ["configured", "default", "environment", "derived"] },
                workspacePath: { type: "string", enum: ["configured", "default", "environment", "derived"] },
                outputDirectory: { type: "string", enum: ["configured", "default", "environment", "derived"] },
              },
            },
            persistence: {
              type: "object",
              required: ["enabled"],
              properties: {
                enabled: { type: "boolean" },
              },
            },
            mutable: {
              type: "array",
              items: { type: "string", enum: ["autoCompact", "autoSummary", "autoSummaryDelayMs"] },
            },
          },
        },
        AgentSettingsPatch: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            autoCompact: { type: "boolean" },
            autoSummary: { type: "boolean" },
            autoSummaryDelayMs: { type: "number", description: "Milliseconds; values are clamped to 60000..900000." },
          },
        },
        ProductGoalRun: {
          type: "object",
          required: ["id", "goalId", "sessionId", "status", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string" },
            goalId: { type: "string" },
            sessionId: { type: "string" },
            status: { type: "string" },
            role: { type: "string" },
            progress: { type: "number" },
            currentStep: { type: "string" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
          },
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
            artifactId: { type: "string" },
            currentRun: { $ref: "#/components/schemas/ProductGoalRun" },
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
