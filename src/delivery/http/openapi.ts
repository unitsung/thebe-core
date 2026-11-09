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
  extraStatuses?: Array<{
    status: number;
    description: string;
    schema?: string;
  }>;
  parameters?: Array<Record<string, unknown>>;
};

const jsonSchema = { type: "object", additionalProperties: true };
const idParameter = (name = "id") => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});
const queryParameter = (
  name: string,
  schema: Record<string, unknown> = { type: "string" }
) => ({
  name,
  in: "query",
  required: false,
  schema,
});

const operations: Operation[] = [
  {
    method: "get",
    path: "/v1/schedules",
    summary: "List durable Goal schedules",
    tag: "goal",
    responseSchema: "GoalScheduleList",
  },
  {
    method: "post",
    path: "/v1/schedules",
    summary: "Create a durable Goal schedule",
    tag: "goal",
    response: 201,
    requestBody: { required: true },
    requestSchema: "GoalScheduleInput",
    responseSchema: "GoalSchedule",
  },
  {
    method: "get",
    path: "/v1/schedules/{id}",
    summary: "Read a Goal schedule",
    tag: "goal",
    parameters: [idParameter()],
    responseSchema: "GoalSchedule",
  },
  {
    method: "put",
    path: "/v1/schedules/{id}",
    summary: "Edit a Goal schedule",
    tag: "goal",
    parameters: [idParameter()],
    requestBody: { required: true },
    requestSchema: "GoalScheduleInput",
    responseSchema: "GoalSchedule",
  },
  {
    method: "patch",
    path: "/v1/schedules/{id}",
    summary: "Pause or resume scheduling",
    tag: "goal",
    parameters: [idParameter()],
    requestBody: { required: true },
    requestSchema: "GoalScheduleEnabled",
    responseSchema: "GoalSchedule",
  },
  {
    method: "delete",
    path: "/v1/schedules/{id}",
    summary: "Delete a schedule without stopping its Goal",
    tag: "goal",
    parameters: [idParameter()],
    responseSchema: "Ok",
  },
  {
    method: "post",
    path: "/v1/schedules/{id}/run",
    summary: "Run now through the normal Goal lifecycle",
    tag: "goal",
    parameters: [idParameter()],
    responseSchema: "GoalSchedule",
  },
  {
    method: "get",
    path: "/v1/health",
    summary:
      "Health check, including Source read health and durable push state when enabled",
    tag: "system",
    responseSchema: "Health",
  },
  {
    method: "get",
    path: "/v1/events",
    summary: "Recent process events",
    tag: "system",
  },
  {
    method: "get",
    path: "/v1/event",
    summary: "Recent process events (singular compatibility alias)",
    tag: "system",
  },
  {
    method: "get",
    path: "/v1/devices",
    summary: "List registered push devices",
    tag: "compatibility",
    responseSchema: "DeviceRegistrationList",
  },
  {
    method: "post",
    path: "/v1/devices",
    summary: "Register a push device",
    tag: "compatibility",
    requestBody: { required: true },
    requestSchema: "DeviceRegistrationRequest",
    responseSchema: "DeviceRegistration",
  },
  {
    method: "delete",
    path: "/v1/devices/{registrationId}",
    summary: "Remove a registered push device",
    tag: "compatibility",
    parameters: [idParameter("registrationId")],
    responseSchema: "Ok",
  },
  {
    method: "get",
    path: "/v1/push/quiet-hours",
    summary: "Read the daily window in which Core holds its pushes",
    tag: "compatibility",
  },
  {
    method: "put",
    path: "/v1/push/quiet-hours",
    summary:
      "Set the quiet-hours window ({quietHours: {start, end, timeZone?}}) or turn it off with null",
    tag: "compatibility",
    requestBody: { required: true },
  },
  {
    method: "post",
    path: "/v1/messages",
    summary: "Send a prompt (compatibility endpoint)",
    tag: "compatibility",
    requestBody: { required: true },
  },
  {
    method: "get",
    path: "/v1/system/status",
    summary: "Read maintenance state",
    tag: "system",
  },
  {
    method: "get",
    path: "/v1/system/isolation",
    summary:
      "Read the effective isolation posture (sandbox, guard, guard rails)",
    tag: "system",
  },
  {
    method: "post",
    path: "/v1/system/quiesce",
    summary: "Enter maintenance mode",
    tag: "system",
  },
  {
    method: "post",
    path: "/v1/system/unquiesce",
    summary: "Leave maintenance mode",
    tag: "system",
  },
  {
    method: "post",
    path: "/v1/system/reap",
    summary: "Reap idle sessions",
    tag: "system",
  },
  {
    method: "get",
    path: "/v1/agent/running",
    summary: "List running sessions",
    tag: "system",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.capabilities,
    summary: "List homelab capabilities",
    tag: "capabilities",
    responseSchema: "CapabilityList",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.metricsSummary,
    summary:
      "Summarize how the assistant has been working (Goal outcomes and durations, approval waits, external-agent calls), computed on request from what Core already keeps",
    tag: "metrics",
    parameters: [
      queryParameter("days", {
        type: "integer",
        minimum: 1,
        maximum: 365,
        default: 30,
      }),
    ],
    responseSchema: "MetricsSummary",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.audit,
    summary: "Read the redacted append-only audit log",
    tag: "audit",
    parameters: [
      queryParameter("limit", {
        type: "integer",
        minimum: 1,
        maximum: 200,
        default: 100,
      }),
      queryParameter("cursor", { type: "string" }),
      queryParameter("sessionId"),
      queryParameter("method"),
      queryParameter("identity"),
      queryParameter("result", {
        type: "string",
        enum: ["ok", "error", "denied"],
      }),
    ],
    responseSchema: "AuditList",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.audit}/{id}`,
    summary: "Read one redacted audit record",
    tag: "audit",
    parameters: [idParameter()],
    responseSchema: "AuditRecord",
  },
  {
    method: "post",
    path: `${PRODUCT_HTTP_PATH.capabilities}/{id}/${PRODUCT_HTTP_SEGMENT.invoke}`,
    summary: "Invoke a capability through ThebeAgent",
    tag: "capabilities",
    parameters: [idParameter()],
    requestBody: { required: true },
    requestSchema: "CapabilityInvokeRequest",
    responseSchema: "CapabilityInvokeResult",
    extraStatuses: [
      {
        status: 202,
        description: "Background run started",
        schema: "CapabilityInvokeResult",
      },
      { status: 403, description: "Write requires POST /v1/action" },
    ],
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.capabilities}/${PRODUCT_HTTP_SEGMENT.runs}`,
    summary: "List persisted background capability runs",
    tag: "capabilities",
    responseSchema: "CapabilityRunList",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.capabilities}/${PRODUCT_HTTP_SEGMENT.runs}/{runId}`,
    summary: "Read a background capability run",
    tag: "capabilities",
    parameters: [idParameter("runId")],
    responseSchema: "CapabilityRun",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.capabilities}/${PRODUCT_HTTP_SEGMENT.runs}/{runId}/${PRODUCT_HTTP_SEGMENT.log}`,
    summary: "Follow a background capability run over SSE",
    tag: "capabilities",
    parameters: [idParameter("runId")],
    responseSchema: "CapabilityRun",
    responseContentType: "text/event-stream",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.subagents}/${PRODUCT_HTTP_SEGMENT.profiles}`,
    summary: "List subagent profiles",
    tag: "workers",
    responseSchema: "SubagentProfileList",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.subagents,
    summary: "List subagent runs",
    tag: "workers",
    parameters: [queryParameter("parentSessionId")],
    responseSchema: "WorkerList",
  },
  {
    method: "post",
    path: PRODUCT_HTTP_PATH.subagents,
    summary: "Spawn a subagent worker",
    tag: "workers",
    response: 201,
    requestBody: { required: true },
    requestSchema: "SpawnWorkerRequest",
    responseSchema: "ProductWorker",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.subagents}/{runId}`,
    summary: "Inspect one subagent run",
    tag: "workers",
    parameters: [idParameter("runId")],
    responseSchema: "ProductWorker",
  },
  {
    method: "post",
    path: `${PRODUCT_HTTP_PATH.subagents}/{runId}/${PRODUCT_HTTP_SEGMENT.cancel}`,
    summary: "Cancel a subagent run",
    tag: "workers",
    parameters: [idParameter("runId")],
    responseSchema: "ProductWorker",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.subagents}/{runId}/${PRODUCT_HTTP_SEGMENT.log}`,
    summary:
      "Read worker activity or follow its SSE log without the parent transcript",
    tag: "workers",
    parameters: [idParameter("runId")],
    responseSchema: "WorkerLog",
    responseContentType: "text/event-stream",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.permissions,
    summary: "List runtime pending permissions (not Activity Approvals)",
    tag: "permissions",
    responseSchema: "PendingPermissionList",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.permissions}/{id}`,
    summary: "Read one pending permission with redacted input",
    tag: "permissions",
    parameters: [idParameter()],
    responseSchema: "PendingPermission",
  },
  {
    method: "post",
    path: `${PRODUCT_HTTP_PATH.permissions}/{id}/${PRODUCT_HTTP_SEGMENT.resolve}`,
    summary: "Approve or deny a pending permission",
    tag: "permissions",
    parameters: [idParameter()],
    requestBody: { required: true },
    requestSchema: "PermissionResolution",
    responseSchema: "Ok",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.skills,
    summary: "List skills",
    tag: "skills",
    responseSchema: "SkillList",
  },
  {
    method: "post",
    path: PRODUCT_HTTP_PATH.skills,
    summary: "Import a new disabled workspace skill",
    tag: "skills",
    response: 201,
    requestBody: { required: true },
    requestSchema: "SkillImport",
    responseSchema: "Skill",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.skills}/{name}`,
    summary: "Get skill metadata",
    tag: "skills",
    parameters: [idParameter("name")],
    responseSchema: "Skill",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.skills}/{name}/content`,
    summary: "Download skill instructions with a content hash",
    tag: "skills",
    parameters: [idParameter("name")],
    responseSchema: "SkillContent",
  },
  {
    method: "patch",
    path: `${PRODUCT_HTTP_PATH.skills}/{name}`,
    summary: "Enable or disable a skill",
    tag: "skills",
    parameters: [idParameter("name")],
    requestBody: { required: true },
    requestSchema: "SkillPatch",
    responseSchema: "Skill",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.mcpExtensions}/${PRODUCT_HTTP_SEGMENT.servers}`,
    summary: "List MCP servers",
    tag: "extensions",
    responseSchema: "McpServerList",
  },
  {
    method: "post",
    path: `${PRODUCT_HTTP_PATH.mcpExtensions}/${PRODUCT_HTTP_SEGMENT.servers}`,
    summary: "Add a new disabled MCP server",
    tag: "extensions",
    response: 201,
    requestBody: { required: true },
    requestSchema: "McpServerRegistration",
    responseSchema: "McpServer",
  },
  {
    method: "delete",
    path: `${PRODUCT_HTTP_PATH.mcpExtensions}/${PRODUCT_HTTP_SEGMENT.servers}/{name}`,
    summary: "Remove an MCP server registered through Thebe",
    tag: "extensions",
    parameters: [idParameter("name")],
    responseSchema: "Ok",
  },
  {
    method: "patch",
    path: `${PRODUCT_HTTP_PATH.mcpExtensions}/${PRODUCT_HTTP_SEGMENT.servers}/{name}`,
    summary: "Enable or disable an MCP server",
    tag: "extensions",
    parameters: [idParameter("name")],
    requestBody: { required: true },
    requestSchema: "McpServerPatch",
    responseSchema: "McpServer",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.mcpExtensions}/${PRODUCT_HTTP_SEGMENT.tools}`,
    summary: "List external MCP tools",
    tag: "extensions",
    responseSchema: "McpToolList",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.enabledResources,
    summary: "List enabled Agent resources",
    tag: "resources",
    responseSchema: "EnabledResourceList",
  },
  {
    method: "post",
    path: `${PRODUCT_HTTP_PATH.enabledResources}/artifact`,
    summary: "Capture enabled resources as an Artifact",
    tag: "resources",
    responseSchema: "AgentArtifact",
  },
  {
    method: "put",
    path: `${PRODUCT_HTTP_PATH.enabledResources}/{id}`,
    summary: "Put an enabled resource",
    tag: "resources",
    parameters: [idParameter()],
    requestBody: { required: true },
    requestSchema: "EnabledResourceWrite",
    responseSchema: "EnabledResource",
  },
  {
    method: "delete",
    path: `${PRODUCT_HTTP_PATH.enabledResources}/{id}`,
    summary: "Remove an enabled resource",
    tag: "resources",
    parameters: [idParameter()],
    responseSchema: "Ok",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.artifacts,
    summary: "List bounded product Artifacts",
    tag: "artifacts",
    parameters: [
      queryParameter("kind", {
        type: "string",
        enum: [
          "diagnosis",
          "report",
          "resource_list",
          "operation_receipt",
          "task_output",
        ],
      }),
      queryParameter("sessionId"),
      queryParameter("runId"),
      queryParameter("createdAfter"),
      queryParameter("createdBefore"),
      queryParameter("limit", { type: "integer", minimum: 1, maximum: 100 }),
    ],
    responseSchema: "ArtifactList",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.artifacts}/{id}`,
    summary: "Read Artifact metadata",
    tag: "artifacts",
    parameters: [idParameter()],
    responseSchema: "AgentArtifact",
  },
  {
    method: "get",
    path: `${PRODUCT_HTTP_PATH.artifacts}/{id}/content`,
    summary: "Read bounded Artifact content",
    tag: "artifacts",
    parameters: [idParameter()],
    responseSchema: "ArtifactContent",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.permissionSettings,
    summary: "Read permission mode",
    tag: "settings",
    responseSchema: "PermissionModeSettings",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.fullAccessSettings,
    summary: "Read whether the full-access preset is allowed on this host",
    tag: "settings",
    responseSchema: "FullAccessSupport",
  },
  {
    method: "patch",
    path: PRODUCT_HTTP_PATH.permissionSettings,
    summary: "Set permission mode",
    tag: "settings",
    requestBody: { required: true },
    requestSchema: "PermissionModeSettings",
    responseSchema: "PermissionModeSettings",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.agentSettings,
    summary: "Read effective Agent settings",
    tag: "settings",
    responseSchema: "AgentSettings",
  },
  {
    method: "patch",
    path: PRODUCT_HTTP_PATH.agentSettings,
    summary: "Update mutable Agent settings",
    tag: "settings",
    requestBody: { required: true },
    requestSchema: "AgentSettingsPatch",
    responseSchema: "AgentSettings",
    extraStatuses: [
      { status: 409, description: "A setting requires a Core restart" },
    ],
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.memory,
    summary: "Read Thebe Memory",
    tag: "settings",
    responseSchema: "MemoryState",
  },
  {
    method: "post",
    path: `${PRODUCT_HTTP_PATH.memory}/operations`,
    summary: "Edit Thebe Memory as its owner (no approval)",
    tag: "settings",
    requestBody: { required: true },
    requestSchema: "MemoryOperations",
    responseSchema: "MemoryEditResult",
    extraStatuses: [
      { status: 404, description: "Memory is not enabled on this Core" },
    ],
  },
  {
    method: "post",
    path: "/v1/diagnosis",
    summary: "Run a read-only container diagnosis",
    tag: "diagnosis",
    requestBody: { required: true },
    responseSchema: "DiagnosisResult",
  },
  {
    method: "get",
    path: "/v1/diagnosis/{runId}",
    summary: "Read a diagnosis run",
    tag: "diagnosis",
    parameters: [idParameter("runId")],
    responseSchema: "DiagnosisResult",
  },
  {
    method: "post",
    path: "/v1/diagnosis/{runId}/why",
    summary: "Ask why a diagnosis was reached",
    tag: "diagnosis",
    parameters: [idParameter("runId")],
    requestBody: { required: false },
    responseSchema: "DiagnosisResult",
  },
  {
    method: "post",
    path: "/v1/action",
    summary: "Execute an approved container_restart",
    tag: "action",
    requestBody: { required: true },
    requestSchema: "ActionRequest",
    responseSchema: "ActionReceipt",
    extraStatuses: [
      {
        status: 403,
        description: "Action requires on-device approval",
        schema: "ActionReceipt",
      },
    ],
  },
  {
    method: "get",
    path: "/v1/action/{receiptId}",
    summary: "Read an action receipt",
    tag: "action",
    parameters: [idParameter("receiptId")],
    responseSchema: "ActionReceipt",
  },
  {
    method: "get",
    path: "/v1/activity",
    summary:
      "List Activity workspace items (approval, receipt, diagnosis, goal, run, worker, background task)",
    tag: "activity",
    parameters: [
      queryParameter("group", {
        type: "string",
        enum: ["needs_approval", "running", "recent"],
      }),
      queryParameter("source", {
        type: "string",
        enum: [
          "approval",
          "receipt",
          "diagnosis",
          "goal",
          "run",
          "worker",
          "background_task",
        ],
      }),
      queryParameter("stage", {
        type: "string",
        enum: ["person", "working", "idle", "ended"],
      }),
      queryParameter("status"),
      queryParameter("updatedAfter", { type: "string", format: "date-time" }),
      queryParameter("updatedBefore", { type: "string", format: "date-time" }),
      queryParameter("limit", {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 50,
      }),
      queryParameter("cursor"),
    ],
    responseSchema: "ActivityList",
  },
  {
    method: "get",
    path: "/v1/activity/{id}",
    summary: "Read one Activity workspace item",
    tag: "activity",
    parameters: [idParameter()],
    responseSchema: "ActivityItem",
  },
  {
    method: "post",
    path: "/v1/activity/{id}/deny",
    summary: "Reject a pending Approval and remove it from Activity",
    tag: "activity",
    parameters: [idParameter()],
  },
  {
    method: "get",
    path: "/v1/policy",
    summary: "Read the rules and accept mode Eval weighs events by",
    tag: "ticket",
    responseSchema: "Policy",
  },
  {
    method: "put",
    path: "/v1/policy",
    summary:
      "Change the rules, the accept mode (off, observe or auto) or the model",
    tag: "ticket",
    requestBody: { required: true },
    requestSchema: "PolicyInput",
    responseSchema: "Policy",
  },
  {
    method: "get",
    path: "/v1/decisions",
    summary: "List Eval decisions, newest first; ?thread= and ?limit= filter",
    tag: "ticket",
    responseSchema: "DecisionList",
  },
  {
    method: "get",
    path: "/v1/decisions/{id}",
    summary: "Read one Decision",
    tag: "ticket",
    parameters: [idParameter()],
    responseSchema: "Decision",
  },
  {
    method: "get",
    path: "/v1/tickets",
    summary: "List Tickets, newest first",
    tag: "ticket",
    responseSchema: "TicketList",
  },
  {
    method: "post",
    path: "/v1/tickets",
    summary:
      "Delegate one direct Ticket and Goal, idempotent by the caller's key",
    tag: "ticket",
    response: 201,
    requestBody: { required: true },
    requestSchema: "TicketDelegateRequest",
    responseSchema: "TicketDelegation",
    extraStatuses: [
      {
        status: 200,
        description: "The same idempotency key returned the existing Ticket",
        schema: "TicketDelegation",
      },
    ],
  },
  {
    method: "get",
    path: "/v1/tickets/{id}",
    summary: "Read one Ticket",
    tag: "ticket",
    parameters: [idParameter()],
    responseSchema: "Ticket",
  },
  {
    method: "post",
    path: "/v1/tickets/{id}/reply",
    summary:
      "Answer or review a Ticket's Attention, or resolve one pending worker permission",
    tag: "ticket",
    parameters: [idParameter()],
    requestBody: { required: true },
    requestSchema: "TicketReplyRequest",
    responseSchema: "TicketTask",
  },
  {
    method: "get",
    path: PRODUCT_HTTP_PATH.mainSession,
    summary:
      "Read the durable main Session without creating it; initialized is false until its first message",
    tag: "main-session",
    responseSchema: "MainSession",
  },
  {
    method: "post",
    path: `${PRODUCT_HTTP_PATH.mainSession}/${PRODUCT_HTTP_SEGMENT.messages}`,
    summary:
      "Start or resume the one durable person-facing Session and run one turn",
    tag: "main-session",
    requestBody: { required: true },
    requestSchema: "MainSessionPromptRequest",
    responseSchema: "MainSessionPromptResponse",
  },
  {
    method: "post",
    path: `${PRODUCT_HTTP_PATH.mainSession}/${PRODUCT_HTTP_SEGMENT.interrupt}`,
    summary:
      "Interrupt the current main Session turn without creating an uninitialized Session",
    tag: "main-session",
    responseSchema: "Ok",
  },
  {
    method: "post",
    path: "/v1/goals",
    summary: "Create a session and start a Goal",
    tag: "goal",
    response: 201,
    requestBody: { required: true },
    requestSchema: "GoalCreateRequest",
    responseSchema: "ProductGoal",
  },
  {
    method: "get",
    path: "/v1/goals",
    summary: "List persisted Goals",
    tag: "goal",
    responseSchema: "ProductGoalList",
  },
  {
    method: "get",
    path: "/v1/goals/{id}",
    summary: "Read one Goal (id is thebeSessionId)",
    tag: "goal",
    parameters: [idParameter()],
    responseSchema: "ProductGoal",
  },
  {
    method: "post",
    path: "/v1/goals/{id}/pause",
    summary: "Pause a running Goal after the current checkpoint",
    tag: "goal",
    parameters: [idParameter()],
    responseSchema: "ProductGoal",
  },
  {
    method: "post",
    path: "/v1/goals/{id}/resume",
    summary:
      "Resume a paused Goal (409 attention_open while it waits on an answer or review: use /answer; 409 ticket_mandate_invalid when the current Policy no longer authorizes an Eval Ticket)",
    tag: "goal",
    parameters: [idParameter()],
    responseSchema: "ProductGoal",
  },
  {
    method: "post",
    path: "/v1/goals/{id}/answer",
    summary:
      "Answer the question a paused Goal is waiting on, or accept / send back a result waiting for review (409 ticket_mandate_invalid when continuing an Eval Ticket no longer follows the current Policy)",
    tag: "goal",
    parameters: [idParameter()],
    requestBody: { required: true },
    requestSchema: "GoalAnswerRequest",
    responseSchema: "ProductGoal",
  },
  {
    method: "post",
    path: "/v1/goals/{id}/stop",
    summary: "Cancel a Goal",
    tag: "goal",
    parameters: [idParameter()],
    responseSchema: "ProductGoal",
  },
  {
    method: "get",
    path: "/v1/goals/{id}/log",
    summary: "Read Goal events or follow an SSE log",
    tag: "goal",
    parameters: [
      idParameter(),
      queryParameter("follow", { type: "boolean" }),
      queryParameter("after", { type: "integer", minimum: 0 }),
    ],
    responseContentType: "text/event-stream",
  },
  {
    method: "get",
    path: "/v1/session",
    summary: "List sessions",
    tag: "session",
    parameters: [
      queryParameter("status"),
      queryParameter("hostId"),
      queryParameter("environmentId"),
    ],
  },
  {
    method: "post",
    path: "/v1/session",
    summary: "Create a session",
    tag: "session",
    response: 201,
    requestBody: { required: false },
  },
  {
    method: "get",
    path: "/v1/session/status",
    summary: "List session statuses",
    tag: "session",
  },
  {
    method: "get",
    path: "/v1/session/{id}",
    summary: "Get session metadata",
    tag: "session",
    parameters: [idParameter()],
  },
  {
    method: "patch",
    path: "/v1/session/{id}",
    summary: "Update session metadata",
    tag: "session",
    parameters: [idParameter()],
    requestBody: { required: true },
  },
  {
    method: "delete",
    path: "/v1/session/{id}",
    summary: "Delete a session",
    tag: "session",
    parameters: [idParameter()],
  },
  {
    method: "get",
    path: "/v1/session/{id}/children",
    summary: "List forked children",
    tag: "session",
    parameters: [idParameter()],
  },
  {
    method: "get",
    path: "/v1/session/{id}/context",
    summary: "Get context usage",
    tag: "session",
    parameters: [idParameter()],
  },
  {
    method: "get",
    path: "/v1/session/{id}/message",
    summary: "Read paginated messages",
    tag: "messages",
    parameters: [
      idParameter(),
      queryParameter("limit", { type: "integer", minimum: 1 }),
      queryParameter("before"),
      queryParameter("after"),
    ],
  },
  {
    method: "get",
    path: "/v1/session/{id}/message/{messageId}",
    summary: "Read one message",
    tag: "messages",
    parameters: [idParameter(), idParameter("messageId")],
  },
  {
    method: "get",
    path: "/v1/session/{id}/log",
    summary: "Read events or follow an SSE log",
    tag: "events",
    parameters: [
      idParameter(),
      queryParameter("follow", { type: "boolean" }),
      queryParameter("after", { type: "integer", minimum: 0 }),
    ],
    responseContentType: "text/event-stream",
  },
  {
    method: "get",
    path: "/v1/session/{id}/background-task",
    summary: "List background tasks",
    tag: "session",
    parameters: [idParameter()],
  },
  {
    method: "post",
    path: "/v1/session/{id}/background-task/{taskId}/stop",
    summary: "Stop one background task",
    tag: "session",
    parameters: [idParameter(), idParameter("taskId")],
  },
  {
    method: "post",
    path: "/v1/session/{id}/background-task/stop-all",
    summary: "Stop all background tasks",
    tag: "session",
    parameters: [idParameter()],
  },
  {
    method: "post",
    path: "/v1/session/{id}/prompt",
    summary: "Submit a prompt",
    tag: "prompt",
    parameters: [idParameter()],
    requestBody: { required: true },
  },
  {
    method: "post",
    path: "/v1/session/{id}/interrupt",
    summary: "Interrupt the current run",
    tag: "prompt",
    parameters: [idParameter()],
  },
  {
    method: "get",
    path: "/v1/session/{id}/permissions",
    summary: "The permission mode this session runs in",
    tag: "session",
    parameters: [idParameter()],
  },
  {
    method: "put",
    path: "/v1/session/{id}/permissions",
    summary:
      "Set the permission mode of this session (null returns it to the host default)",
    tag: "session",
    parameters: [idParameter()],
    requestBody: { required: true },
  },
  {
    method: "post",
    path: "/v1/session/{id}/full-access",
    summary:
      "Enable or disable bypassPermissions for the session (older form of PUT permissions)",
    tag: "session",
    parameters: [idParameter()],
    requestBody: { required: true },
  },
  {
    method: "post",
    path: "/v1/session/{id}/bash",
    summary: "Run one already-approved command in the session (host-gated)",
    tag: "session",
    parameters: [idParameter()],
    requestBody: { required: true },
    extraStatuses: [
      {
        status: 403,
        description:
          "The host does not allow remote commands (remote_bash_not_allowed) or the command guard refused the command (command_refused)",
      },
    ],
  },
  {
    method: "post",
    path: "/v1/session/{id}/permission/{permissionId}",
    summary: "Resolve a permission request",
    tag: "prompt",
    parameters: [idParameter(), idParameter("permissionId")],
    requestBody: { required: true },
  },
  {
    method: "post",
    path: "/v1/session/{id}/tool-call/{toolCallId}/stop",
    summary: "Stop one tool call",
    tag: "prompt",
    parameters: [idParameter(), idParameter("toolCallId")],
  },
  {
    method: "post",
    path: "/v1/session/{id}/compact",
    summary: "Compact the session",
    tag: "prompt",
    parameters: [idParameter()],
    requestBody: { required: false },
  },
  {
    method: "post",
    path: "/v1/session/{id}/fork",
    summary: "Fork a session",
    tag: "session",
    parameters: [idParameter()],
    requestBody: { required: false },
  },
  {
    method: "post",
    path: "/v1/session/{id}/revert",
    summary: "Revert the current branch",
    tag: "session",
    parameters: [idParameter()],
  },
  {
    method: "post",
    path: "/v1/session/{id}/unrevert",
    summary: "Unrevert the current branch",
    tag: "session",
    parameters: [idParameter()],
  },
  {
    method: "post",
    path: "/v1/session/{id}/model",
    summary: "Set session model",
    tag: "models",
    parameters: [idParameter()],
    requestBody: { required: true },
  },
  {
    method: "post",
    path: "/v1/session/{id}/thinking",
    summary: "Set thinking level",
    tag: "models",
    parameters: [idParameter()],
    requestBody: { required: true },
  },
  {
    method: "get",
    path: "/v1/session/{id}/export",
    summary: "Export a session",
    tag: "session",
    parameters: [
      idParameter(),
      queryParameter("format", { type: "string", enum: ["jsonl", "html"] }),
    ],
  },
  {
    method: "get",
    path: "/v1/session/{id}/diff",
    summary: "Get workspace git diff",
    tag: "session",
    parameters: [idParameter()],
  },
  {
    method: "get",
    path: "/v1/provider",
    summary: "List providers",
    tag: "providers",
    parameters: [queryParameter("all", { type: "boolean" })],
  },
  {
    method: "get",
    path: "/v1/provider/auth",
    summary: "List provider auth status",
    tag: "providers",
  },
  {
    method: "get",
    path: "/v1/model",
    summary: "List models",
    tag: "models",
    parameters: [
      queryParameter("all", { type: "boolean" }),
      queryParameter("provider"),
      queryParameter("refresh", { type: "boolean" }),
    ],
  },
  {
    method: "get",
    path: "/v1/provider/{providerId}/config",
    summary: "Read editable provider configuration without credentials",
    tag: "providers",
    parameters: [idParameter("providerId")],
  },
  {
    method: "put",
    path: "/v1/provider/{providerId}/config",
    summary:
      "Save endpoint and replace custom model definitions, including each model's thinkingLevelMap (level to provider value, null when not offered)",
    tag: "providers",
    parameters: [idParameter("providerId")],
    requestBody: { required: true },
  },
  {
    method: "delete",
    path: "/v1/provider/{providerId}/config",
    summary: "Remove custom provider configuration and credentials",
    tag: "providers",
    parameters: [idParameter("providerId")],
  },
  {
    method: "post",
    path: "/v1/provider/{providerId}/test",
    summary: "Test a provider",
    tag: "providers",
    parameters: [idParameter("providerId")],
  },
  {
    method: "post",
    path: "/v1/provider/{providerId}/api-key",
    summary: "Set an API key",
    tag: "providers",
    parameters: [idParameter("providerId")],
    requestBody: { required: true },
  },
  {
    method: "delete",
    path: "/v1/provider/{providerId}/api-key",
    summary: "Delete an API key",
    tag: "providers",
    parameters: [idParameter("providerId")],
  },
  {
    method: "get",
    path: "/v1/provider/{providerId}/oauth/login",
    summary: "Start OAuth login (SSE)",
    tag: "providers",
    parameters: [idParameter("providerId")],
    responseContentType: "text/event-stream",
  },
  {
    method: "post",
    path: "/v1/provider/{providerId}/oauth/authorize",
    summary: "Authorize OAuth (force starts a fresh login)",
    tag: "providers",
    parameters: [idParameter("providerId")],
    requestBody: { required: false },
    requestSchema: "OAuthAuthorizeRequest",
    responseSchema: "OAuthAuthorizeResult",
    extraStatuses: [
      {
        status: 202,
        description: "Authorization pending",
        schema: "OAuthAuthorizeResult",
      },
    ],
  },
  {
    method: "post",
    path: "/v1/provider/{providerId}/oauth/callback",
    summary: "Submit OAuth callback",
    tag: "providers",
    parameters: [idParameter("providerId")],
    requestBody: { required: true },
  },
  {
    method: "post",
    path: "/v1/provider/{providerId}/oauth/login",
    summary: "Submit OAuth callback (compatibility alias)",
    tag: "providers",
    parameters: [idParameter("providerId")],
    requestBody: { required: true },
  },
  {
    method: "post",
    path: "/v1/provider/{providerId}/oauth/logout",
    summary: "Logout OAuth",
    tag: "providers",
    parameters: [idParameter("providerId")],
  },
  {
    method: "delete",
    path: "/v1/provider/{providerId}/oauth/logout",
    summary: "Logout OAuth",
    tag: "providers",
    parameters: [idParameter("providerId")],
  },
  {
    method: "post",
    path: "/v1/auth",
    summary: "Set an API key (compatibility endpoint)",
    tag: "providers",
    requestBody: { required: true },
  },
  {
    method: "put",
    path: "/v1/auth/{providerId}",
    summary: "Set an API key (compatibility endpoint)",
    tag: "providers",
    parameters: [idParameter("providerId")],
    requestBody: { required: true },
  },
  {
    method: "delete",
    path: "/v1/auth/{providerId}",
    summary: "Logout provider (compatibility endpoint)",
    tag: "providers",
    parameters: [idParameter("providerId")],
  },
  {
    method: "post",
    path: "/v1/oauth/pairing-code",
    summary: "Issue a short-lived one-time OAuth pairing code",
    tag: "mcp",
    response: 201,
    responseSchema: "OAuthPairingCode",
  },
  {
    method: "post",
    path: "/mcp",
    summary: "MCP JSON-RPC endpoint",
    tag: "mcp",
    requestBody: { required: true },
  },
];

function schemaRef(name?: string): Record<string, unknown> {
  return name ? { $ref: `#/components/schemas/${name}` } : jsonSchema;
}

/**
 * Where an Activity item stands for the person, derived on every read and never stored. `person` needs
 * them now (`reason` approval: a write waits for their yes; stalled: Watchdog exhausted its bounded
 * self-help; failed: it did not finish in the last 24 hours), `working` is queued or running, `idle`
 * is a plain pause, `ended` is history. The stages never
 * overlap and cover every item; `GET /v1/activity?stage=person` is the list Home counts.
 */
const ACTIVITY_STAGE_PROPERTIES = {
  stage: { type: "string", enum: ["person", "working", "idle", "ended"] },
  reason: {
    type: "string",
    enum: ["approval", "failed", "blocked", "answer", "review", "stalled"],
  },
} as const;

/** A count with the median and 95th percentile of what was counted. */
const SPREAD = {
  type: "object",
  required: ["count"],
  properties: {
    count: { type: "integer" },
    p50: { type: "number" },
    p95: { type: "number" },
  },
} as const;

export function createOpenApiDocument(version: string): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const operation of operations) {
    const path = (paths[operation.path] ??= {});
    const successStatus = String(operation.response ?? 200);
    const responses: Record<string, unknown> = {
      [successStatus]: {
        description:
          operation.response === 501
            ? "Feature is not available"
            : "Successful response",
        content: {
          [operation.responseContentType ?? "application/json"]: {
            schema:
              operation.responseContentType === "text/event-stream"
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
          ? {
              content: {
                "application/json": { schema: schemaRef(extra.schema) },
              },
            }
          : {}),
      };
    }
    path[operation.method] = {
      summary: operation.summary,
      operationId: `${operation.method}_${operation.path.replaceAll(/[{}/]/g, "_").replaceAll(/_+/g, "_")}`,
      tags: [operation.tag],
      parameters: operation.parameters,
      requestBody: operation.requestBody
        ? {
            ...operation.requestBody,
            content: {
              "application/json": {
                schema: schemaRef(operation.requestSchema),
              },
            },
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
      description:
        "Thebe Core session, prompt, runtime, provider, and MCP API. The JSON document is generated by the running server.",
    },
    servers: [{ url: "/" }],
    // Token auth is optional in development and required in production; the
    // empty requirement keeps both deployment modes accurately documented.
    security: [{}, { ThebeToken: [] }, { ThebeBearer: [] }],
    tags: [
      { name: "system", description: "Health and lifecycle controls" },
      { name: "session", description: "Session lifecycle and metadata" },
      { name: "messages", description: "Runtime transcript messages" },
      { name: "events", description: "Normalized events and SSE logs" },
      { name: "prompt", description: "Prompt execution and approvals" },
      { name: "models", description: "Model selection" },
      {
        name: "providers",
        description: "Provider discovery and authentication",
      },
      {
        name: "capabilities",
        description: "Homelab capability discovery and Agent-mediated invoke",
      },
      {
        name: "metrics",
        description:
          "Read-only summary computed from existing records; nothing is collected or sent anywhere",
      },
      {
        name: "audit",
        description:
          "Read-only redacted audit records; raw parameters are never returned",
      },
      {
        name: "workers",
        description: "Subagent runs presented as Workers; no parent transcript",
      },
      {
        name: "permissions",
        description:
          "Runtime pending tool permissions. Distinct from Activity diagnose-restart Approvals.",
      },
      {
        name: "skills",
        description:
          "Skill import/list/get/enable; existing skill files are never overwritten",
      },
      {
        name: "extensions",
        description: "Product MCP inventory; raw /mcp remains for integrations",
      },
      {
        name: "resources",
        description: "Enabled Agent resources/context, not a Resource database",
      },
      {
        name: "artifacts",
        description: "Bounded, redacted product results owned by Core",
      },
      {
        name: "settings",
        description: "Runtime behavior settings consumed by clients",
      },
      {
        name: "diagnosis",
        description:
          "Product-facing read-only diagnosis; clients do not call raw MCP tools",
      },
      {
        name: "action",
        description:
          "Approved write actions (container_restart) with deterministic verification receipts",
      },
      {
        name: "activity",
        description:
          "Typed Approval, Receipt, Diagnosis, Goal, Capability Run, Worker, and Background Task items; lifecycle remains owned by each source object",
      },
      {
        name: "ticket",
        description:
          "Tickets: durable authorised units of work. The Ticket carries identity and mandate; the Goal behind it keeps progress, reports, Attention and pending permissions.",
      },
      {
        name: "main-session",
        description:
          "The one durable person-facing Session. It can inspect and control Tickets but has no shell, file or edit tools.",
      },
      {
        name: "goal",
        description:
          "Durable ProductGoal attached to one parent session. Identity is thebeSessionId (id === sessionId). Runtime pausing collapses to running. Session-scoped aliases live under /v1/session/{id}/goal*.",
      },
      {
        name: "compatibility",
        description: "Legacy compatibility endpoints",
      },
      { name: "mcp", description: "MCP JSON-RPC" },
    ],
    paths,
    components: {
      securitySchemes: {
        ThebeToken: { type: "apiKey", in: "header", name: "X-Thebe-Token" },
        ThebeBearer: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            error: { type: "string" },
            code: { type: "string" },
          },
        },
        Ok: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
        Health: {
          type: "object",
          required: ["ok", "version", "capabilities"],
          properties: {
            ok: { type: "boolean" },
            version: { type: "string" },
            capabilities: {
              type: "array",
              items: { type: "string" },
            },
            sources: {
              type: "array",
              items: { $ref: "#/components/schemas/SourceHealth" },
            },
            push: { $ref: "#/components/schemas/PushOutboxStatus" },
          },
        },
        MainSession: {
          type: "object",
          required: ["id", "initialized"],
          properties: {
            id: {
              type: "string",
              enum: ["thebe-main"],
              description:
                "The stable id of the one main Session owned by this Core.",
            },
            initialized: {
              type: "boolean",
              description:
                "False until a person sends the main Session its first message.",
            },
            session: {
              type: "object",
              additionalProperties: true,
              description:
                "Session metadata and current run state when initialized.",
            },
          },
        },
        MainSessionPromptRequest: {
          type: "object",
          description:
            "The main Session accepts the same text, file attachments and prompt modes as a normal Session; its id cannot be overridden. Model and thinking selections are applied before the prompt.",
          properties: {
            text: { type: "string" },
            mode: {
              type: "string",
              enum: ["prompt", "steer", "followUp"],
            },
            files: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            model: {
              type: "object",
              required: ["providerId", "modelId"],
              properties: {
                providerId: { type: "string" },
                modelId: { type: "string" },
              },
            },
            thinking: {
              type: "string",
              enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
            },
          },
        },
        MainSessionPromptResponse: {
          type: "object",
          required: ["text", "tools", "thebeSessionId"],
          properties: {
            text: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
            thebeSessionId: {
              type: "string",
              enum: ["thebe-main"],
            },
          },
        },
        SourceHealth: {
          type: "object",
          required: ["id", "scope", "state", "consecutiveFailures"],
          properties: {
            id: { type: "string" },
            scope: { type: "string" },
            state: {
              type: "string",
              enum: ["starting", "healthy", "failing"],
            },
            consecutiveFailures: { type: "integer", minimum: 0 },
            lastAttemptAt: { type: "string", format: "date-time" },
            lastSuccessAt: { type: "string", format: "date-time" },
            lastFailureAt: { type: "string", format: "date-time" },
            lastError: { type: "string" },
          },
        },
        PushOutboxStatus: {
          type: "object",
          required: ["pending", "consecutiveFailures", "dropped"],
          properties: {
            pending: { type: "integer", minimum: 0 },
            consecutiveFailures: { type: "integer", minimum: 0 },
            dropped: { type: "integer", minimum: 0 },
            lastError: { type: "string" },
            lastFailureAt: { type: "string", format: "date-time" },
            lastDrop: {
              type: "object",
              required: ["id", "reason", "at"],
              properties: {
                id: { type: "string" },
                reason: { type: "string" },
                at: { type: "string", format: "date-time" },
              },
            },
          },
        },
        OAuthAuthorizeRequest: {
          type: "object",
          properties: {
            force: {
              type: "boolean",
              description:
                "Start a new OAuth flow even when the current credential is connected.",
            },
          },
        },
        OAuthAuthorizeResult: {
          type: "object",
          required: ["ok", "providerId"],
          properties: {
            ok: { type: "boolean" },
            providerId: { type: "string" },
            connected: { type: "boolean" },
            pending: { type: "boolean" },
            url: { type: "string", format: "uri" },
            instructions: { type: "string" },
            deviceCode: { type: "object", additionalProperties: true },
          },
        },
        OAuthPairingCode: {
          type: "object",
          required: ["ok", "code", "expiresAt"],
          properties: {
            ok: { type: "boolean" },
            code: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        AuditRecord: {
          type: "object",
          required: [
            "id",
            "timestamp",
            "method",
            "parameterHash",
            "responseBytes",
            "budgetConsumed",
            "redactionFired",
          ],
          properties: {
            id: { type: "string" },
            timestamp: { type: "string" },
            method: { type: "string" },
            parameterHash: { type: "string" },
            summary: {
              type: "string",
              description:
                "For a call that changes something: its arguments, redacted and shortened.",
            },
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
        MetricsSummary: {
          type: "object",
          required: [
            "windowDays",
            "generatedAt",
            "goals",
            "approvals",
            "gateway",
          ],
          properties: {
            windowDays: { type: "integer" },
            generatedAt: { type: "string" },
            goals: {
              type: "object",
              required: [
                "started",
                "outcomes",
                "observeOnly",
                "completionSeconds",
              ],
              properties: {
                started: { type: "integer" },
                outcomes: {
                  type: "object",
                  properties: {
                    succeeded: { type: "integer" },
                    failed: { type: "integer" },
                    blocked: { type: "integer" },
                    cancelled: { type: "integer" },
                    running: { type: "integer" },
                    paused: { type: "integer" },
                  },
                },
                observeOnly: { type: "integer" },
                completionSeconds: SPREAD,
              },
            },
            approvals: {
              type: "object",
              required: ["decided", "pending", "waitSeconds"],
              properties: {
                decided: { type: "integer" },
                pending: { type: "integer" },
                waitSeconds: SPREAD,
              },
            },
            gateway: {
              type: "object",
              required: ["calls", "denied", "errors", "byCaller"],
              properties: {
                calls: { type: "integer" },
                denied: { type: "integer" },
                errors: { type: "integer" },
                byCaller: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      identity: { type: "string" },
                      calls: { type: "integer" },
                      denied: { type: "integer" },
                      errors: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        AuditList: {
          type: "object",
          required: ["entries"],
          properties: {
            entries: {
              type: "array",
              items: { $ref: "#/components/schemas/AuditRecord" },
            },
            nextCursor: { type: "string" },
          },
        },
        HomelabCapability: {
          type: "object",
          required: [
            "id",
            "name",
            "description",
            "inputSchema",
            "category",
            "permission",
            "source",
          ],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            inputSchema: { type: "object", additionalProperties: true },
            category: {
              type: "string",
              enum: [...HOMELAB_CAPABILITY_CATEGORIES],
            },
            permission: { type: "string", enum: ["read", "confirm", "admin"] },
            effect: { type: "string", enum: ["read", "write"] },
            risk: { type: "string", enum: ["low", "disruptive"] },
            approval: { type: "string", enum: ["none", "required"] },
            service: { type: "string" },
            source: { type: "string", enum: ["core", "external"] },
            serverName: { type: "string" },
            resourceKinds: { type: "array", items: { type: "string" } },
            execution: {
              type: "string",
              enum: ["direct", "agent", "goal", "either"],
            },
            background: { type: "boolean" },
            destructive: { type: "boolean" },
            outputKind: { type: "string" },
          },
        },
        CapabilityList: {
          type: "object",
          required: ["capabilities"],
          properties: {
            capabilities: {
              type: "array",
              items: { $ref: "#/components/schemas/HomelabCapability" },
            },
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
            artifactId: {
              type: "string",
              description:
                "Report Artifact created from a direct capability result",
            },
          },
        },
        CapabilityRun: {
          type: "object",
          required: ["runId", "capabilityId", "status", "createdAt"],
          properties: {
            runId: { type: "string" },
            capabilityId: { type: "string" },
            status: {
              type: "string",
              enum: ["queued", "running", "succeeded", "failed", "interrupted"],
            },
            artifactId: { type: "string" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
            finishedAt: { type: "string" },
            recovery: { type: "string", enum: ["restored", "interrupted"] },
            resource: { type: "object", additionalProperties: true },
            result: { description: "Direct invoke payload", nullable: true },
            error: { type: "string" },
          },
        },
        CapabilityRunList: {
          type: "object",
          required: ["runs"],
          properties: {
            runs: {
              type: "array",
              items: { $ref: "#/components/schemas/CapabilityRun" },
            },
          },
        },
        DiagnosisResult: {
          type: "object",
          required: [
            "runId",
            "actionId",
            "status",
            "resource",
            "observations",
            "diagnosis",
            "recommendations",
            "technicalDetails",
          ],
          properties: {
            runId: { type: "string" },
            artifactId: { type: "string" },
            actionId: { type: "string", enum: ["container_diagnose"] },
            status: {
              type: "string",
              enum: [
                "completed",
                "failed",
                "provider_unavailable",
                "insufficient_data",
              ],
            },
            resource: { type: "object", additionalProperties: true },
            observations: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            diagnosis: { type: "object", additionalProperties: true },
            recommendations: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            technicalDetails: { type: "object", additionalProperties: true },
            error: { type: "string" },
            sessionId: { type: "string" },
            approvalId: { type: "string" },
          },
        },
        ActionRequest: {
          type: "object",
          required: ["actionId", "resource"],
          properties: {
            actionId: { type: "string", enum: ["container_restart"] },
            resource: { $ref: "#/components/schemas/ResourceRef" },
            diagnosisRunId: { type: "string" },
            idempotencyKey: { type: "string" },
            approval: {
              type: "object",
              required: ["approved"],
              properties: {
                approved: { type: "boolean" },
                approvedAt: { type: "string" },
                client: { type: "string" },
              },
            },
          },
        },
        ActionReceipt: {
          type: "object",
          required: [
            "receiptId",
            "actionId",
            "resource",
            "approval",
            "action",
            "verification",
            "idempotencyKey",
            "tokenUsed",
          ],
          properties: {
            receiptId: { type: "string" },
            artifactId: { type: "string" },
            actionId: { type: "string", enum: ["container_restart"] },
            resource: { $ref: "#/components/schemas/ResourceRef" },
            diagnosisRunId: { type: "string" },
            approval: { type: "object", additionalProperties: true },
            action: { type: "object", additionalProperties: true },
            verification: { type: "object", additionalProperties: true },
            idempotencyKey: { type: "string" },
            tokenUsed: { type: "boolean" },
            error: { type: "string" },
          },
        },
        ResourceRef: {
          type: "object",
          required: ["kind", "id", "provider"],
          properties: {
            kind: { type: "string", enum: ["container"] },
            id: { type: "string" },
            name: { type: "string" },
            provider: {
              type: "string",
              enum: ["arcane", "portainer", "docker", "unknown"],
            },
            instanceId: { type: "string" },
            environmentId: { type: "string" },
            endpointId: { type: "integer" },
            image: { type: "string" },
            labels: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
        },
        ActivityRecord: {
          type: "object",
          required: [
            "id",
            "kind",
            "actionId",
            "resource",
            "status",
            "group",
            "summary",
            "createdAt",
            "updatedAt",
            "idempotencyKey",
          ],
          properties: {
            id: { type: "string" },
            kind: {
              type: "string",
              enum: ["container_restart", "container_diagnose"],
            },
            actionId: {
              type: "string",
              enum: ["container_restart", "container_diagnose"],
            },
            resource: { $ref: "#/components/schemas/ResourceRef" },
            status: {
              type: "string",
              enum: [
                "pending",
                "succeeded",
                "failed",
                "rejected",
                "provider_unavailable",
                "verification_failed",
                "completed",
                "insufficient_data",
              ],
            },
            group: {
              type: "string",
              enum: ["needs_approval", "running", "recent"],
            },
            summary: { type: "string" },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
            diagnosisRunId: { type: "string" },
            receiptId: { type: "string" },
            artifactId: { type: "string" },
            idempotencyKey: { type: "string" },
            approval: { type: "object", additionalProperties: true },
            action: { type: "object", additionalProperties: true },
            verification: { type: "object", additionalProperties: true },
            diagnosis: { type: "object", additionalProperties: true },
            observations: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            recommendations: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
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
            ...ACTIVITY_STAGE_PROPERTIES,
            approval: { $ref: "#/components/schemas/ActivityRecord" },
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
            ...ACTIVITY_STAGE_PROPERTIES,
            receipt: { $ref: "#/components/schemas/ActivityRecord" },
          },
        },
        ActivityDiagnosisItem: {
          type: "object",
          required: ["type", "id", "group", "updatedAt", "diagnosis"],
          properties: {
            type: { type: "string", enum: ["diagnosis"] },
            id: { type: "string" },
            group: { type: "string", enum: ["recent"] },
            updatedAt: { type: "string" },
            ...ACTIVITY_STAGE_PROPERTIES,
            diagnosis: { $ref: "#/components/schemas/ActivityRecord" },
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
            ...ACTIVITY_STAGE_PROPERTIES,
            goal: { $ref: "#/components/schemas/ProductGoal" },
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
            ...ACTIVITY_STAGE_PROPERTIES,
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
            ...ACTIVITY_STAGE_PROPERTIES,
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
            ...ACTIVITY_STAGE_PROPERTIES,
            task: { $ref: "#/components/schemas/ProductBackgroundTask" },
          },
        },
        ActivityItem: {
          oneOf: [
            { $ref: "#/components/schemas/ActivityApprovalItem" },
            { $ref: "#/components/schemas/ActivityReceiptItem" },
            { $ref: "#/components/schemas/ActivityDiagnosisItem" },
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
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/ActivityItem" },
            },
            nextCursor: { type: "string" },
          },
        },
        ProductWorker: {
          type: "object",
          required: [
            "runId",
            "parentSessionId",
            "profileName",
            "task",
            "status",
          ],
          properties: {
            runId: { type: "string" },
            parentSessionId: { type: "string" },
            profileName: { type: "string" },
            task: { type: "string" },
            status: {
              type: "string",
              enum: [
                "queued",
                "running",
                "completed",
                "failed",
                "cancelled",
                "interrupted",
              ],
            },
            turns: { type: "integer" },
            maxTurns: { type: "integer" },
            createdAt: { type: "string" },
            startedAt: { type: "string" },
            finishedAt: { type: "string" },
            artifactId: { type: "string" },
            responseText: { type: "string" },
            activity: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
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
            provider: { type: "string" },
            kind: { type: "string" },
            name: { type: "string" },
            pid: { type: "integer" },
            port: { type: "integer" },
            status: { type: "string", enum: ["running", "stopped", "failed"] },
            startedAt: { type: "string" },
            finishedAt: { type: "string" },
            updatedAt: { type: "string" },
            error: { type: "string" },
            artifactId: { type: "string" },
            resource: {
              $ref: "#/components/schemas/ProductBackgroundTaskResource",
            },
          },
        },
        ProductBackgroundTaskResource: {
          type: "object",
          required: ["kind", "provider", "id"],
          properties: {
            kind: { type: "string" },
            provider: { type: "string" },
            id: { type: "string" },
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
            profiles: {
              type: "array",
              items: { $ref: "#/components/schemas/ProductSubagentProfile" },
            },
          },
        },
        WorkerList: {
          type: "object",
          required: ["subagents"],
          properties: {
            subagents: {
              type: "array",
              items: { $ref: "#/components/schemas/ProductWorker" },
            },
          },
        },
        WorkerLog: {
          type: "object",
          required: ["activity"],
          properties: {
            activity: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
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
          required: [
            "registrationId",
            "platform",
            "categories",
            "registeredAt",
            "updatedAt",
          ],
          properties: {
            registrationId: { type: "string" },
            platform: { type: "string", enum: ["ios"] },
            deviceId: { type: "string" },
            relayDeviceId: { type: "string" },
            categories: { type: "array", items: { type: "string" } },
            registeredAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        DeviceRegistrationList: {
          type: "object",
          required: ["devices"],
          properties: {
            devices: {
              type: "array",
              items: { $ref: "#/components/schemas/DeviceRegistration" },
            },
          },
        },
        DeviceRegistrationRequest: {
          type: "object",
          required: ["token", "platform"],
          properties: {
            token: { type: "string", maxLength: 512, writeOnly: true },
            platform: { type: "string", enum: ["ios"] },
            deviceId: { type: "string" },
            categories: {
              type: "array",
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 64 },
            },
          },
        },
        PendingPermission: {
          type: "object",
          required: [
            "id",
            "sessionId",
            "toolName",
            "title",
            "requestedAt",
            "rememberScopes",
          ],
          properties: {
            id: { type: "string" },
            sessionId: { type: "string" },
            toolName: { type: "string" },
            title: { type: "string" },
            reason: { type: "string" },
            input: { description: "Redacted tool arguments", nullable: true },
            argsSummary: { type: "string" },
            requestedAt: { type: "string" },
            rememberScopes: {
              type: "array",
              items: {
                type: "string",
                enum: ["request", "tool", "conversation"],
              },
            },
            risk: { type: "string", enum: ["high", "standard"] },
          },
        },
        PendingPermissionList: {
          type: "object",
          required: ["permissions"],
          properties: {
            permissions: {
              type: "array",
              items: { $ref: "#/components/schemas/PendingPermission" },
            },
          },
        },
        PermissionResolution: {
          type: "object",
          required: ["response"],
          properties: {
            response: { type: "string", enum: ["allow", "deny"] },
            remember: { type: "boolean" },
            rememberScope: {
              type: "string",
              enum: ["request", "tool", "conversation"],
            },
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
        SkillContent: {
          type: "object",
          required: ["name", "description", "content", "contentHash"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            content: { type: "string" },
            contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
        SkillList: {
          type: "object",
          required: ["skills"],
          properties: {
            skills: {
              type: "array",
              items: { $ref: "#/components/schemas/Skill" },
            },
          },
        },
        SkillPatch: {
          type: "object",
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
        SkillImport: {
          type: "object",
          required: ["content"],
          properties: {
            content: {
              type: "string",
              description: "Complete SKILL.md, at most 1 MB",
            },
          },
        },
        McpServerRegistration: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
            },
            url: { type: "string" },
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            env: { type: "object", additionalProperties: { type: "string" } },
            headers: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            description: { type: "string", maxLength: 300 },
            exposure: {
              type: "string",
              enum: ["codemode", "deferred", "direct", "hidden"],
              description:
                "How the model reaches the tools. Default codemode; deferred makes them loadable by tool_search.",
            },
          },
          description:
            "Provide either url or command. Saved disabled; enable separately. Credentials are never returned.",
        },
        McpServer: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            command: { type: "string" },
            url: { type: "string" },
            service: { type: "string" },
            category: { type: "string" },
            permission: { type: "string" },
            status: {
              type: "string",
              enum: ["disabled", "configured"],
              description:
                "Configured state only. Connections belong to the runtime's session.",
            },
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
          description:
            "External MCP tool. Same shape as HomelabCapability with source=external.",
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
            servers: {
              type: "array",
              items: { $ref: "#/components/schemas/McpServer" },
            },
          },
        },
        McpToolList: {
          type: "object",
          required: ["tools"],
          properties: {
            tools: {
              type: "array",
              items: { $ref: "#/components/schemas/McpTool" },
            },
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
            resources: {
              type: "array",
              items: { $ref: "#/components/schemas/EnabledResource" },
            },
          },
        },
        AgentArtifact: {
          type: "object",
          required: [
            "artifactId",
            "kind",
            "title",
            "createdAt",
            "updatedAt",
            "contentType",
            "sizeBytes",
          ],
          properties: {
            artifactId: { type: "string" },
            kind: {
              type: "string",
              enum: [
                "diagnosis",
                "report",
                "resource_list",
                "operation_receipt",
                "task_output",
              ],
            },
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
            artifacts: {
              type: "array",
              items: { $ref: "#/components/schemas/AgentArtifact" },
            },
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
            mode: {
              type: "string",
              enum: ["plan", "manual", "acceptEdits", "bypassPermissions"],
            },
          },
        },
        FullAccessSupport: {
          type: "object",
          required: ["allowed"],
          properties: {
            allowed: {
              type: "boolean",
              description:
                "Always true. bypassPermissions is selectable; the TUI and graphical clients confirm before turning it on. THEBE_FULL_ACCESS is ignored.",
            },
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
            "instructions",
            "sandboxEnabled",
            "sandboxAllowedDomains",
            "sandboxDeniedDomains",
            "sources",
            "persistence",
            "mutable",
          ],
          properties: {
            autoCompact: { type: "boolean" },
            autoSummary: { type: "boolean" },
            autoSummaryDelayMs: {
              type: "integer",
              minimum: 60000,
              maximum: 900000,
            },
            permissionMode: {
              type: "string",
              enum: ["plan", "manual", "acceptEdits", "bypassPermissions"],
            },
            maxSubagentConcurrency: {
              type: "integer",
              minimum: 1,
              maximum: 16,
            },
            maxSubagentsPerParent: { type: "integer", minimum: 1, maximum: 16 },
            workspacePath: { type: "string" },
            outputDirectory: { type: "string" },
            instructions: {
              type: "string",
              maxLength: 4096,
              description:
                "The owner's standing instructions, added to the system prompt of sessions opened after the change. At most 4096 UTF-8 bytes; empty when none.",
            },
            sandboxEnabled: {
              type: "boolean",
              description:
                "Effective OS sandbox for host bash. False inside a container, when THEBE_SANDBOX=off, or when turned off here. Default true on a host.",
            },
            sandboxAllowedDomains: {
              type: "array",
              items: { type: "string" },
              description:
                "Hosts remembered from an allow. Empty until the user allows one. A new host still asks.",
            },
            sandboxDeniedDomains: {
              type: "array",
              items: { type: "string" },
              description:
                "Hosts remembered from a denial. Checked before the user is asked.",
            },
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
                "instructions",
                "sandboxEnabled",
              ],
              properties: {
                autoCompact: {
                  type: "string",
                  enum: ["configured", "default", "environment", "derived"],
                },
                autoSummary: {
                  type: "string",
                  enum: ["configured", "default", "environment", "derived"],
                },
                autoSummaryDelayMs: {
                  type: "string",
                  enum: ["configured", "default", "environment", "derived"],
                },
                permissionMode: {
                  type: "string",
                  enum: ["configured", "default", "environment", "derived"],
                },
                maxSubagentConcurrency: {
                  type: "string",
                  enum: ["configured", "default", "environment", "derived"],
                },
                maxSubagentsPerParent: {
                  type: "string",
                  enum: ["configured", "default", "environment", "derived"],
                },
                workspacePath: {
                  type: "string",
                  enum: ["configured", "default", "environment", "derived"],
                },
                outputDirectory: {
                  type: "string",
                  enum: ["configured", "default", "environment", "derived"],
                },
                instructions: {
                  type: "string",
                  enum: ["configured", "default", "environment", "derived"],
                },
                sandboxEnabled: {
                  type: "string",
                  enum: ["configured", "default", "environment", "derived"],
                },
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
              items: {
                type: "string",
                enum: [
                  "autoCompact",
                  "autoSummary",
                  "autoSummaryDelayMs",
                  "instructions",
                  "sandboxEnabled",
                  "sandboxAllowedDomains",
                  "sandboxDeniedDomains",
                ],
              },
            },
          },
        },
        MemoryStore: {
          type: "object",
          required: ["entries", "usedBytes", "limitBytes"],
          properties: {
            entries: { type: "array", items: { type: "string" } },
            usedBytes: { type: "integer" },
            limitBytes: { type: "integer" },
          },
        },
        MemoryView: {
          type: "object",
          required: ["user", "notes"],
          properties: {
            user: { $ref: "#/components/schemas/MemoryStore" },
            notes: { $ref: "#/components/schemas/MemoryStore" },
          },
        },
        MemoryState: {
          type: "object",
          required: ["enabled", "memory"],
          properties: {
            enabled: { type: "boolean" },
            memory: { $ref: "#/components/schemas/MemoryView" },
          },
        },
        MemoryOperations: {
          type: "object",
          required: ["target", "operations"],
          additionalProperties: false,
          properties: {
            target: { type: "string", enum: ["user", "notes"] },
            operations: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                required: ["action"],
                properties: {
                  action: { type: "string", enum: ["add", "patch", "remove"] },
                  content: { type: "string" },
                  old_text: { type: "string" },
                },
              },
            },
          },
        },
        MemoryEditResult: {
          type: "object",
          required: ["ok", "memory"],
          properties: {
            ok: { type: "boolean" },
            memory: { $ref: "#/components/schemas/MemoryView" },
          },
        },
        AgentSettingsPatch: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            autoCompact: { type: "boolean" },
            autoSummary: { type: "boolean" },
            autoSummaryDelayMs: {
              type: "number",
              description: "Milliseconds; values are clamped to 60000..900000.",
            },
            instructions: {
              type: "string",
              maxLength: 4096,
              description:
                "At most 4096 UTF-8 bytes (400 over the limit). Empty clears them. Applies to sessions opened afterwards.",
            },
            sandboxEnabled: { type: "boolean" },
            sandboxAllowedDomains: { type: "array", items: { type: "string" } },
            sandboxDeniedDomains: { type: "array", items: { type: "string" } },
          },
        },
        ProductGoalRun: {
          type: "object",
          required: [
            "id",
            "goalId",
            "sessionId",
            "status",
            "createdAt",
            "updatedAt",
          ],
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
        GoalCreateRequest: {
          type: "object",
          required: ["goal"],
          properties: {
            goal: { type: "string", minLength: 1 },
            criteria: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            maxIterations: { type: "integer", minimum: 1, maximum: 32 },
            observe: {
              type: "boolean",
              description:
                "Run read-only: the worker has no edit, write or shell tool and reports what it found and would do.",
            },
            allowAsk: {
              type: "boolean",
              description:
                "Let the worker ask the person one question mid-run (the Goal pauses with an `attention`). Without it, a need becomes a blocker.",
            },
            reviewBeforeDone: {
              type: "boolean",
              description:
                "After the independent review passes, pause with a review `attention` and wait for the person to accept or send it back.",
            },
            threads: {
              type: "array",
              items: { type: "string" },
              description:
                "Thread keys this task concerns, e.g. resource:container:emby. While the task is open, later triggers on these threads attach as inputs without a new assessment.",
            },
            model: {
              type: "object",
              required: ["providerId", "modelId"],
              description:
                "Model for a new Goal session; its workers and reviewer use it. Ignored when the Goal is started on an existing session.",
              properties: {
                providerId: { type: "string" },
                modelId: { type: "string" },
              },
            },
          },
        },
        GoalScheduleInput: {
          type: "object",
          required: ["title", "goal", "startAt"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            goal: { type: "string", minLength: 1, maxLength: 16000 },
            startAt: { type: "string", format: "date-time" },
            intervalMinutes: {
              type: "integer",
              minimum: 5,
              maximum: 525600,
              description:
                "Fixed elapsed minutes; omitted means one shot. Missed intervals are not replayed.",
            },
            cron: {
              type: "string",
              maxLength: 100,
              description:
                "Five-field cron (minute hour day-of-month month day-of-week) read in timeZone, instead of intervalMinutes. startAt is the earliest run. Missed runs are not replayed.",
            },
            timeZone: {
              type: "string",
              description:
                "IANA zone the cron is read in, such as Asia/Shanghai; defaults to the Core host's zone.",
            },
            criteria: {
              type: "array",
              maxItems: 32,
              items: { type: "string", minLength: 1, maxLength: 2000 },
            },
            maxIterations: { type: "integer", minimum: 1, maximum: 32 },
            acceptMode: {
              type: "string",
              enum: ["auto", "observe"],
              description:
                "observe runs each occurrence read-only: its worker has no edit, write or shell tool and reports what it found and would do.",
            },
            allowAsk: {
              type: "boolean",
              description:
                "Each occurrence's worker may ask the person one question mid-run.",
            },
            reviewBeforeDone: {
              type: "boolean",
              description:
                "Each occurrence waits for the person to accept after it passes its independent review.",
            },
            model: {
              type: "object",
              required: ["providerId", "modelId"],
              description:
                "Model for each occurrence's Goal session; its workers and reviewer use it. Omitted means the host default.",
              properties: {
                providerId: { type: "string" },
                modelId: { type: "string" },
              },
            },
          },
        },
        GoalSchedule: {
          allOf: [
            { $ref: "#/components/schemas/GoalScheduleInput" },
            {
              type: "object",
              required: ["id", "enabled", "createdAt", "updatedAt"],
              properties: {
                id: { type: "string" },
                enabled: { type: "boolean" },
                createdAt: { type: "string", format: "date-time" },
                updatedAt: { type: "string", format: "date-time" },
                nextRunAt: { type: "string", format: "date-time" },
                lastRunAt: { type: "string", format: "date-time" },
                lastSessionId: { type: "string" },
                lastError: { type: "string" },
                dispatching: { type: "boolean" },
              },
            },
          ],
        },
        GoalScheduleEnabled: {
          type: "object",
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
        GoalScheduleList: {
          type: "object",
          required: ["schedules"],
          properties: {
            schedules: {
              type: "array",
              items: { $ref: "#/components/schemas/GoalSchedule" },
            },
          },
        },
        PolicyRule: {
          type: "object",
          required: ["id", "text"],
          properties: { id: { type: "string" }, text: { type: "string" } },
        },
        Policy: {
          type: "object",
          required: ["rules", "acceptMode", "revision", "updatedAt"],
          properties: {
            rules: {
              type: "array",
              items: { $ref: "#/components/schemas/PolicyRule" },
            },
            acceptMode: {
              type: "string",
              enum: ["off", "observe", "auto"],
              description:
                "off: record events, weigh none. observe (the default): weigh each against the rules and record what Core WOULD have taken on; it takes on nothing. auto: a positive assessment is taken on as a Ticket, which an executor carries out within its Mandate. The rules are the authority; nothing acts until the person picks auto.",
            },
            modes: {
              type: "array",
              items: { type: "string" },
              description:
                "The accept modes this Core has, so a client offers auto only where it exists. Sent in responses; an older Core does not send it.",
            },
            model: {
              type: "object",
              properties: {
                providerId: { type: "string" },
                modelId: { type: "string" },
              },
              description:
                "The model that weighs events; unset means Core's default.",
            },
            revision: { type: "integer" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        PolicyInput: {
          type: "object",
          description:
            "Any of these; what is left out stays as it was. rules is a list of plain-language strings (at most 20, 500 characters each). model: null returns to Core's default.",
          properties: {
            rules: { type: "array", items: { type: "string" } },
            acceptMode: { type: "string", enum: ["off", "observe", "auto"] },
            model: {
              type: "object",
              nullable: true,
              properties: {
                providerId: { type: "string" },
                modelId: { type: "string" },
              },
            },
          },
        },
        DecisionList: {
          type: "object",
          required: ["decisions"],
          properties: {
            decisions: {
              type: "array",
              items: { $ref: "#/components/schemas/Decision" },
            },
          },
        },
        Decision: {
          type: "object",
          description:
            "What Eval decided about the events on one thread. In observe a positive assessment is outcome ignore with wouldAccept true. In auto, outcome accept means it was taken on as a Ticket (ticketId, goalId); a positive assessment that was not taken on stays ignore with wouldAccept and notTakenOn. unavailable means no answer could be had (limit, timeout, bad reply): never read it as a no.",
          required: [
            "id",
            "evalId",
            "thread",
            "triggerIds",
            "at",
            "outcome",
            "matchedRuleIds",
            "reason",
            "policyVersion",
            "decidedAt",
          ],
          properties: {
            id: { type: "string" },
            evalId: { type: "string" },
            thread: {
              type: "string",
              description: "e.g. resource:container:emby",
            },
            triggerIds: { type: "array", items: { type: "string" } },
            at: { type: "string", format: "date-time" },
            outcome: {
              type: "string",
              enum: ["accept", "stop", "ignore", "unavailable"],
            },
            wouldAccept: { type: "boolean" },
            matchedRuleIds: { type: "array", items: { type: "string" } },
            reason: { type: "string" },
            unavailableReason: { type: "string" },
            gate: {
              type: "boolean",
              description:
                "The deterministic Gate stopped it before any model was asked.",
            },
            ticketId: {
              type: "string",
              description:
                "auto, accepted: the Ticket that was made. Its Mandate says what the work may touch.",
            },
            goalId: {
              type: "string",
              description:
                "auto, accepted: the Goal that carries the Ticket out.",
            },
            notTakenOn: {
              type: "string",
              description:
                "auto, a positive assessment that was not taken on, and why: thread_limit (one thread is taken on only so often in an hour), quiesced, no_executor or accept_failed.",
            },
            policyVersion: { type: "string" },
            decidedAt: { type: "string", format: "date-time" },
          },
        },
        TicketList: {
          type: "object",
          required: ["tickets"],
          properties: {
            tickets: {
              type: "array",
              items: { $ref: "#/components/schemas/Ticket" },
            },
          },
        },
        Ticket: {
          type: "object",
          description:
            "One authorised unit of work. It wraps existing objects (a Goal keeps its own id and progress); its stage is derived from them, not stored.",
          required: [
            "id",
            "title",
            "mandate",
            "subscriptions",
            "links",
            "createdAt",
          ],
          properties: {
            id: {
              type: "string",
              description:
                "Derived from the decision that produced it, so the same request gives the same id.",
            },
            title: { type: "string" },
            mandate: {
              type: "object",
              required: ["strength", "decidedBy", "evalId", "requester"],
              properties: {
                strength: { type: "string", enum: ["explicit", "inferred"] },
                decidedBy: { type: "string", enum: ["direct", "eval"] },
                evalId: { type: "string" },
                requester: { type: "string" },
                policyVersion: {
                  type: "string",
                  description: "Eval only: the policy it was taken on under.",
                },
                matchedRuleIds: { type: "array", items: { type: "string" } },
                scope: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Eval only: what the Ticket may touch, as service:write (container:write): writes on that service that are not irreversible. Inferred from what the event is about, never from what the model said. Empty authorises nothing to be done without the person.",
                },
              },
            },
            subscriptions: { type: "array", items: { type: "string" } },
            inputs: {
              type: "array",
              items: { $ref: "#/components/schemas/TicketInput" },
              description:
                "Later events on subscribed threads attached to the ticket without a new assessment.",
            },
            links: {
              type: "object",
              required: ["sessionIds"],
              properties: {
                legacyGoalId: { type: "string" },
                sessionIds: { type: "array", items: { type: "string" } },
                decisionId: {
                  type: "string",
                  description: "The Decision that took the work on.",
                },
              },
            },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        TicketDelegateRequest: {
          type: "object",
          required: ["task", "idempotencyKey"],
          properties: {
            task: {
              type: "string",
              maxLength: 16000,
              description:
                "The complete long-running objective. The worker does not inherit the caller's conversation.",
            },
            idempotencyKey: {
              type: "string",
              minLength: 1,
              maxLength: 256,
              description:
                "Stable caller-generated key. Retrying with the same key returns the existing Ticket.",
            },
            criteria: {
              type: "array",
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
            maxIterations: {
              type: "integer",
              minimum: 1,
              maximum: 50,
              description: "Maximum worker checkpoints; defaults to 8.",
            },
            observe: {
              type: "boolean",
              description: "Inspect and report without changing anything.",
            },
            allowAsk: {
              type: "boolean",
              default: true,
              description:
                "Let the worker pause with a question answerable through /v1/tickets/{id}/reply.",
            },
            reviewBeforeDone: {
              type: "boolean",
              description:
                "After independent review passes, wait for the person to accept the result.",
            },
          },
          additionalProperties: false,
        },
        TicketReplyRequest: {
          type: "object",
          properties: {
            attentionId: {
              type: "string",
              description: "The open Attention id from the Ticket or its Goal.",
            },
            answer: {
              type: "string",
              maxLength: 4000,
              description:
                "The answer, or feedback when sending a reviewed result back.",
            },
            decision: {
              type: "string",
              enum: ["accept", "reject"],
              description: "Required when the Attention is a review.",
            },
            permissionId: {
              type: "string",
              description:
                "A pending permission id from TicketTask.pendingPermissions.",
            },
            permissionDecision: {
              type: "string",
              enum: ["allow", "deny"],
              description: "The decision for permissionId.",
            },
          },
          additionalProperties: false,
        },
        TicketTask: {
          type: "object",
          required: ["ticket", "stage", "pendingPermissions", "receipt"],
          properties: {
            ticket: { $ref: "#/components/schemas/Ticket" },
            stage: {
              type: "string",
              enum: [
                "unassigned",
                "running",
                "attention",
                "paused",
                "completed",
                "blocked",
                "failed",
                "cancelled",
              ],
            },
            goal: { $ref: "#/components/schemas/ProductGoal" },
            pendingPermissions: {
              type: "array",
              items: { $ref: "#/components/schemas/PendingPermission" },
            },
            receipt: {
              type: "object",
              required: ["state", "complete"],
              properties: {
                state: {
                  type: "string",
                  enum: [
                    "unassigned",
                    "running",
                    "attention",
                    "paused",
                    "completed",
                    "blocked",
                    "failed",
                    "cancelled",
                  ],
                },
                complete: { type: "boolean" },
                summary: { type: "string" },
                finalReport: { type: "string" },
                artifactId: { type: "string" },
                error: { type: "string" },
              },
            },
          },
        },
        TicketDelegation: {
          allOf: [
            { $ref: "#/components/schemas/TicketTask" },
            {
              type: "object",
              required: ["reused"],
              properties: {
                reused: {
                  type: "boolean",
                  description:
                    "True when this key already named a Ticket and no task was started.",
                },
              },
            },
          ],
        },
        TicketInput: {
          type: "object",
          description:
            "One later event on a subscribed thread attached to the ticket without a new assessment.",
          required: [
            "triggerId",
            "seq",
            "source",
            "kind",
            "thread",
            "at",
            "attachedAt",
          ],
          properties: {
            triggerId: { type: "string" },
            seq: { type: "integer" },
            source: { type: "string" },
            kind: { type: "string" },
            thread: { type: "string" },
            at: { type: "string", format: "date-time" },
            attachedAt: { type: "string", format: "date-time" },
            payload: { type: "object" },
          },
        },
        ProductGoalList: {
          type: "object",
          required: ["goals"],
          properties: {
            goals: {
              type: "array",
              items: { $ref: "#/components/schemas/ProductGoal" },
            },
          },
        },
        ProductGoal: {
          type: "object",
          description:
            "Product-facing Goal. id and sessionId are the parent thebeSessionId.",
          properties: {
            id: { type: "string" },
            sessionId: { type: "string" },
            title: { type: "string" },
            status: {
              type: "string",
              enum: [
                "queued",
                "running",
                "paused",
                "succeeded",
                "failed",
                "cancelled",
              ],
            },
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
            finalReport: {
              type: "string",
              description:
                "The isolated worker/reviewer result retained with a terminal Goal.",
            },
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
                resume: {
                  type: "boolean",
                  description:
                    "False while the Goal waits on an `attention`: answer it instead of resuming.",
                },
                stop: { type: "boolean" },
              },
            },
            attention: {
              type: "object",
              description:
                "The one open request for the person, present while the Goal is paused waiting: a question to answer (kind answer) or a finished result to accept (kind review). Answer it with POST /v1/goals/{id}/answer.",
              required: ["id", "kind", "question", "askedAt"],
              properties: {
                id: { type: "string" },
                kind: { type: "string", enum: ["answer", "review"] },
                question: { type: "string" },
                options: { type: "array", items: { type: "string" } },
                askedAt: { type: "string" },
              },
            },
            ticketId: {
              type: "string",
              description:
                "The Ticket that authorises this task, when one was recorded.",
            },
            report: {
              type: "object",
              description:
                "What the worker last reported through the goal_report tool.",
              required: ["state", "at"],
              properties: {
                state: {
                  type: "string",
                  enum: [
                    "progress",
                    "ready",
                    "blocked",
                    "waiting",
                    "ask",
                    "dropped",
                  ],
                },
                summary: { type: "string" },
                evidence: { type: "string" },
                blocker: { type: "string" },
                question: { type: "string" },
                options: { type: "array", items: { type: "string" } },
                reason: { type: "string" },
                at: { type: "string" },
              },
            },
            watchdog: {
              $ref: "#/components/schemas/GoalWatchdog",
            },
          },
        },
        GoalWatchdog: {
          type: "object",
          description:
            "The Watchdog's latest bounded intervention. `waiting_for_person` is a paused Goal in Activity's person/stalled stage.",
          required: ["state", "reason", "action", "since", "at"],
          properties: {
            state: {
              type: "string",
              enum: ["checking", "retrying", "waiting_for_person"],
            },
            reason: {
              type: "string",
              enum: [
                "goal_no_progress",
                "worker_inactivity",
                "reviewer_inactivity",
              ],
            },
            action: {
              type: "string",
              enum: ["status_check", "retry_worker", "pause"],
            },
            since: { type: "string", format: "date-time" },
            at: { type: "string", format: "date-time" },
            summary: { type: "string" },
          },
        },
        GoalAnswerRequest: {
          type: "object",
          required: ["attentionId"],
          properties: {
            attentionId: {
              type: "string",
              description:
                "The `attention.id` being answered; a stale or already answered one is 409.",
            },
            answer: {
              type: "string",
              maxLength: 4000,
              description:
                "The answer to a question, or the note when sending a result back.",
            },
            decision: {
              type: "string",
              enum: ["accept", "reject"],
              description:
                "For a review request: accept finishes the Goal; reject needs an answer saying what to change.",
            },
          },
        },
      },
    },
  };
}

export function swaggerUiHtml(version: string): string {
  const safeVersion = version.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character
  );
  const title = `Thebe Core API ${safeVersion}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script>
<script src="/docs/swagger-ui-init.js"></script></body></html>`;
}

const require = createRequire(import.meta.url);
const swaggerUiDirectory = dirname(
  require.resolve("swagger-ui-dist/package.json")
);
const swaggerUiInitScript =
  "window.ui=SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true,persistAuthorization:true});";
const swaggerAssets: Record<string, { file: string; contentType: string }> = {
  "/docs/swagger-ui.css": {
    file: "swagger-ui.css",
    contentType: "text/css; charset=utf-8",
  },
  "/docs/swagger-ui-bundle.js": {
    file: "swagger-ui-bundle.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/docs/swagger-ui-standalone-preset.js": {
    file: "swagger-ui-standalone-preset.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/docs/favicon-32x32.png": {
    file: "favicon-32x32.png",
    contentType: "image/png",
  },
  "/docs/favicon-16x16.png": {
    file: "favicon-16x16.png",
    contentType: "image/png",
  },
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
