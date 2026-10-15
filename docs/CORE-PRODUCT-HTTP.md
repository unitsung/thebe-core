# Core product HTTP — shipped vs leftover

Date: 2026-10-06.

## Runtime loading updates (2026-10-08)

Service tools and MCP schemas are registered with deferred exposure. Sessions
start with their configured workspace tools plus `tool_search`; matching schemas
are activated by discovery and existing approvals still gate execution. Skills
remain metadata-first resources. This does not require an MCP server for built-in
capabilities.

Custom `.thebe/agents/*.md` profiles may declare `allowWrites: true` alongside
`tools: [write, edit]`. The default remains false and writes still request parent
session approval. Workers reaching their turn limit without a completed result
are failed, not completed. Provider configuration rejects `maxTokens` larger than
`contextWindow` when both are supplied.

CLI session creation follows the configured model and no longer supplies a fixed
OpenCode fallback. OpenCode-specific environment bootstrap and model shorthand
are removed; explicit provider/model references use the generic provider path.

## Current workspace additions (2026-10-06)

Durable Goal schedules now expose `GET/POST /v1/schedules`,
`GET/PUT/PATCH/DELETE /v1/schedules/{id}` and `POST .../{id}/run`.
Create/edit accepts `title`, `goal`, ISO `startAt`, optional `criteria`,
`maxIterations` (1–32) and `intervalMinutes` (5–525600). Omit the interval
for a one-shot schedule. PATCH accepts `{ enabled: boolean }`. Dates include
a timezone; recurrence uses elapsed minutes, not calendar-day or DST rules.
The App has native create/edit, pause/resume, delete, run-now and linked Goal/log
navigation. Run-now does not change the next scheduled occurrence. Schedule
deletion does not delete or cancel the resulting Goal.

Schedules persist atomically under `{agentStoreDir}/schedules/schedules.json`
(maximum 200). Bootstrap provides a store directory; library embedders that
omit it have an in-memory schedule store. The Agent owns the scheduler; HTTP
never owns a timer or an execution loop. Each occurrence creates a fresh session
and goes through the existing Goal/subagent lifecycle, including approvals.
Quiesce stops the scheduler. Core downtime dispatches at most one due occurrence
and skips backlog; active or paused prior Goals prevent overlap. A reservation
is persisted before dispatch. Interrupted reservations are surfaced for manual
inspection and never replayed automatically. One Core process must own a given
store directory. This does not add multi-process scheduling or remote push.

qBittorrent is an additional native task source. Configure
`THEBE_QBITTORRENT_URL`, `THEBE_QBITTORRENT_USERNAME` and
`THEBE_QBITTORRENT_PASSWORD` in the Core environment. The adapter retains its
authenticated cookie internally, lists up to 100 recent torrents, and uses v4
pause/v5 stop for explicit task control. Finished downloads produce an
allow-listed completion result, excluding save paths and credentials.
`task_output` is now an Artifact kind. Terminal provider task outputs are
redacted, bounded and persisted once per provider/session task identity; task
snapshots expose `artifactId`, never raw output. The App supports filtering this
kind and opening its content from task details. Existing Artifact retention
limits still apply. Authorization/Proxy-Authorization Bearer and Basic tokens
are redacted in logs and Artifact content.

This page records the product HTTP surfaces shipped on `dev`. Delivery still only calls `ThebeAgent`; raw `/mcp` stays the integration surface (see "Raw `/mcp` contract" below). The durable product contract is described in `docs/CORE-NEXT-PRODUCT-SPEC.md`.

## Permission modes (2026-10-14)

One setting decides how much a session may do without asking
(`docs/adr/0004-permission-model.md`): `plan`, `manual`, `acceptEdits`,
`bypassPermissions`. Only these names are accepted; anything else is `400`.

- `GET/PATCH /v1/settings/permissions` — the host default, `{ "mode": … }`.
  Setting `bypassPermissions` here answers `403 full_access_not_allowed` unless the
  host allows it.
- `GET /v1/session/{id}/permissions` — `{ thebeSessionId, mode, inherited }`;
  `inherited` is true when the session has none of its own.
- `PUT /v1/session/{id}/permissions` with `{ "mode": "plan" | … | null }` — sets
  the mode of one session (`null` returns it to the host default) and answers
  `{ thebeSessionId, mode }`. `bypassPermissions` answers
  `403 full_access_not_allowed` unless the host sets `THEBE_FULL_ACCESS=on`.
- `GET /v1/settings/full-access` — `{ allowed }`, whether the host allows
  `bypassPermissions`.
- `POST /v1/session/{id}/full-access` with `{ "enabled": boolean }` — the older
  form: `bypassPermissions` on or off. Answers `{ thebeSessionId, fullAccess }`.

`GET /v1/session/{id}` carries `permissionMode` when the session set its own, so
an App can show a persistent indicator. A subagent, a scheduled occurrence, a
background goal, an `/mcp` caller and a non-interactive turn take the host
default, not the session's own mode.

## Session command route (2026-10-14)

`POST /v1/session/{id}/bash` with `{ "command": string }` runs one command in that session's
workspace and returns `{ exitCode, cancelled, output, truncated }`. It exists for an App whose own
agent has no shell: the App puts the command in front of the user, and only after approval sends it
here. Core cannot see that approval, so the host gate is the control:

- **Off by default.** `THEBE_REMOTE_BASH=on` (or `allow`/`true`/`1`/`yes`) turns it on; otherwise `403`
  `remote_bash_not_allowed` and nothing runs. A client cannot enable it for itself.
- **The command guard always applies**, even if the host turned it off for model tool calls. A command
  rated critical, or dangerous (which the guard would only ask about), is refused with `403`
  `command_refused`; there is no remembered-approval path.
- **Same execution chain as the Pi `bash` tool** (`executeBash`): the configured OS sandbox
  (`THEBE_SANDBOX`) and the sanitized environment. The command is not added to the transcript.
- Output is redacted and cut to its last 30 000 characters (`truncated: true`).
- Every call is audited as `session.bash` with the parameter hash (never the command text) and a result
  of `ok`, `error` or `denied`; a host that has the gate off writes nothing.
- It is not available through `/mcp`, capability invoke or `POST /v1/session/{id}/prompt`.

## Shipped

General web search (2026-10-06, reworked 2026-10-14): when `THEBE_WEB_SEARCH_URL` points to a
SearXNG instance with JSON output enabled, the composition root supplies `web_search` for
model-selected queries on any topic; a root URL uses `/search?q=…&format=json`. Without that
variable Core offers no `web_search` (the public Bing RSS default was removed: poor results, no
uptime guarantee). For web search without running SearXNG, configure a search MCP server instead,
for example Parallel's keyless `https://search.parallel.ai/mcp` (`web_search` and `web_fetch`,
`"exposure": "deferred"`); queries and fetched URLs then go to that provider.

Create or PATCH a session with labels containing `"thebe.webSearch": "false"` to switch
`web_search` and built-in music research off for that session; a missing or other value leaves
them on. Permission is read on each execution, so disabling it preserves conversation history.
Preserve other session labels when updating this value. Results contain bounded titles, excerpts,
source URLs and retrieval time. Remote content is untrusted, and failed searches are surfaced as
tool errors. This label does not change independently configured MCP permissions or
model-provider network access.

Research is budgeted per answer because every result is resent on later turns: at most 5 results of 500 characters per `web_search`, and within a three-minute window at most 8 `web_search` and 6 `music_research` lookups (12 combined), never the same query twice. Beyond that the tool returns a note telling the model to answer from the evidence it has and say what is unverified.

Verification: 667 unit tests passed (one skipped), typecheck/build passed, and
62 Pi/Core fixture checks passed, including live session permission changes and
search evidence reaching the model context. Native App adapter checks also
verified the public feed with an actual network request. A real ClinePass/MiMo
session invoked `web_search`, received public search evidence and cited Apple
official documentation URLs; disabling the permission on that session produced
an explicit disabled-search response. This verifies that provider, not every
model/provider combination.

Local verification update (2026-10-06): provider configuration supports
credential-redacted GET, PUT and DELETE at `/v1/provider/{providerId}/config`.
Model discovery with `/v1/model?provider=…&refresh=true` queries that configured
provider's model endpoint. Explicit custom definitions remain editable, and
deleting a custom provider removes its stored credentials and legacy overrides.

The composition root supplies the read-only `music_research` capability even
without a local music server. Agent tools, capability discovery and invocation
share its contract. MusicBrainz and Wikipedia adapters return bounded candidate
metadata, introductions, links and partial-source errors. Remote text remains
untrusted evidence; the prompt requires matching artist/recording identity and
does not authorize playback from a request for an introduction.

Session background-task queries return the same `ProductBackgroundTask` fields
as Activity, including `sessionId`, provider/kind, errors and resource handles.
Provider task session handles (`provider-arcane`, etc.) identify a provider's
task collection, not a conversational transcript.

Model failures reject the prompt request and publish an `error` log event.
An upstream rejection must not become a successful assistant reply. Pi retry
boundaries do not terminate the log stream; `session_end` is emitted once after
the runtime settles successfully.

| Surface                     | HTTP                                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability discovery        | `GET /v1/capabilities`                                                                                                                                       | Product metadata: category (`files`, `media`, `downloads`, `containers`, `automation`, `diagnostics`, `compute`, `storage`, `network`, `photos`, or `other`), provider/source/service, permission, `resourceKinds`, `execution`, `background`, `destructive`, `outputKind`. The optional Navidrome provider contributes `navidrome.*` media capabilities; playlist writes are approval-gated and cannot be invoked directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Capability invoke           | `POST /v1/capabilities/{id}/invoke`                                                                                                                          | Through `ThebeAgent.invokeCapability` → policy/tools. Direct `{ type: result, artifactId }` or background `{ type: run, runId }`; every direct result is retained as a bounded `report` Artifact. `container.restart` and `approval=required` return 403; use `POST /v1/action`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Capability run              | `GET /v1/capabilities/runs`, `GET /v1/capabilities/runs/{runId}`, `GET /v1/capabilities/runs/{runId}/log`                                                    | Durable snapshots under `{agentStoreDir}/capability-runs`; terminal runs and results survive Core recreation. Runs that reach a terminal state during execution link a bounded `report` Artifact when Artifact storage is available; failed runs retain a redacted error in both the Run and its report. Recovered terminal snapshots expose `recovery: restored`; queued/running runs owned by an older Core instance expose `status: interrupted`, `recovery: interrupted`, and an interruption error. Capability runs are never silently resumed. The log route returns the current snapshot as JSON by default or `capability_update` SSE snapshots when `Accept: text/event-stream` is requested.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Activity feed               | `GET /v1/activity`, `GET /v1/activity/{id}`                                                                                                                  | Typed union of Approval, Receipt, read-only Diagnosis, Goal, Capability Run, Worker, and Background Task items. Supports `group`, `source`, exact `status`, inclusive `updatedAfter`/`updatedBefore`, bounded `limit`, and opaque `cursor`/`nextCursor`; filtering happens before pagination and ordering is stable by `updatedAt` plus id. Diagnosis items retain their ActivityRecord and bounded Artifact link; pending restart recommendations remain Approval items. Capability Runs keep their source `runId`, Workers keep their `ProductWorker` source link without the parent transcript, and Background Tasks keep their source task id plus parent session id. Pi detached Bash snapshots survive runtime recreation; OpenList provider tasks and Arcane provider activities are read from the provider's durable task API with `provider`/`kind` metadata, and a provider task may carry a bounded `resource` handle (`kind`/`provider`/`id`) so a client can deep link to the provider-native object. Runtime and provider tasks use the existing stop/stop-all session seam. Queued/running items are `running`, terminal items are `recent`. |
| Goals                       | `GET/POST /v1/goals`, `GET /v1/goals/{id}`, `POST .../pause`, `POST .../resume`, `POST .../stop`, `GET .../log`                                              | Durable ProductGoal attached to one parent session. A terminal Goal with an isolated worker/reviewer report links a bounded `report` Artifact through `artifactId`; Goal state and report Artifacts survive Core recreation. `updatedAt` advances with lifecycle events so Activity ordering and time filters remain useful while work is running.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Workers                     | `GET/POST /v1/subagents`, `GET /v1/subagents/profiles`, `GET /v1/subagents/{runId}`, `POST .../cancel`, `GET .../log`                                        | Product object is `ProductWorker` mapped from `SubagentRun`. No parent transcript. The log route returns bounded JSON activity by default or sanitized `worker_update` SSE snapshots when `Accept: text/event-stream` is requested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Runtime pending permissions | `GET /v1/permissions`, `GET /v1/permissions/{id}`, `POST /v1/permissions/{id}/resolve`                                                                       | Redacted tool input. Remember scopes: request/tool/conversation. **Not** Activity Approvals. Session `POST /v1/session/{id}/permission/{permissionId}` remains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Skills                      | `GET/POST /v1/skills`, `GET/PATCH /v1/skills/{name}`, `GET /v1/skills/{name}/content`                                                                        | List/get/enable/disable and import a new workspace skill from SKILL.md content. Imports start disabled, cannot overwrite an existing name, and are bounded to 1 MiB. Existing files cannot be edited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| MCP inventory and lifecycle | `GET/POST /v1/extensions/mcp/servers`, `PATCH /v1/extensions/mcp/servers/{name}`, `DELETE /v1/extensions/mcp/servers/{name}`, `GET /v1/extensions/mcp/tools` | Add a new HTTP or executable server to the workspace config in a disabled state, then enable it explicitly. Names cannot overwrite existing servers; responses omit credentials. Server configuration and enable/disable state persist when the registry is recreated. `status` is the configured state only (`disabled` or `configured`); there is no probe or health record, because a model session connects its own servers through the Pi runtime's MCP extension and Core cannot observe that connection from outside. `DELETE` removes a server from the same workspace file that registration writes, drops its persisted enable state, and refreshes idle conversations (404 when unknown, 409 `mcp_server_not_removable` when the server is defined only in another config file such as the global one or `.mcp.json`, 503 while quiesced); editing an existing server's connection stays out of scope. Raw `/mcp` stays for integrations; advertised Core capabilities remain callable there through the Agent seam with the same typed-resource validation.                                                                                     |
| Enabled resources           | `GET /v1/resources/enabled`, `PUT/DELETE /v1/resources/enabled/{id}`, `POST /v1/resources/enabled/artifact`                                                  | Agent context resources (`skill` / `extension` / `prompt`), not an App Resource DB. Selections persist through the Thebe config across Core recreation; the explicit POST captures a bounded `resource_list` Artifact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Permission mode             | `GET/PATCH /v1/settings/permissions`, `GET/PUT /v1/session/{id}/permissions`                                                                                                                         | `ask` \| `read-only` \| `full-access`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Full-access gate            | `GET /v1/settings/full-access`, `POST /v1/session/{id}/full-access`                                                                                          | Host-gated (`THEBE_FULL_ACCESS`, default off), session-scoped. Lifts the command guard, sandbox and approval for one conversation; not inherited by subagents, schedules, background goals, `/mcp`, or non-interactive turns. `GET /v1/session/{id}` carries `fullAccess` for the App indicator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Agent settings              | `GET/PATCH /v1/settings/agent`                                                                                                                               | Effective auto-compact/summary settings, bounded delay, permission mode, concurrency limits, and guarded paths. Mutable fields are auto-compact/summary/delay and `instructions`; concurrency changes report `409 restart_required`. Each value includes a `sources` entry and the response reports `persistence.enabled`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Artifacts                   | `GET /v1/artifacts`, `GET /v1/artifacts/{id}`, `GET /v1/artifacts/{id}/content`                                                                              | Bounded Core-owned metadata/content with kind, session/run/resource links, filters, atomic persistence, server-side redaction, and bounded retention. Operation receipts, Diagnosis runs, enabled-resource snapshots, direct/background Capability results, terminal Goal reports, and terminal Worker reports are producers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Audit log                   | `GET /v1/audit`, `GET /v1/audit/{id}`                                                                                                                        | Read-only redacted records with bounded pagination, filters, and stable detail lookup; raw parameters are never returned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Isolation posture           | `GET /v1/system/isolation`                                                                                                                                   | The effective sandbox mode, whether it is actually **enforced** or would silently **fall back** to running unsandboxed, the backends available on this host, the command guard, the workspace boundary, and the Docker guard, plus a `warnings` array for every relaxed safety layer (any-Host, command guard off, allowed workspace escapes, sandbox fallback). The same report is printed by `thebe doctor`. Read-only, token-gated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Push device registration    | `GET/POST /v1/devices`, `DELETE /v1/devices/{registrationId}`                                                                                                | Durable, token-redacted iOS registrations with notification categories, stable token-derived ids, and de-registration. APNs delivery remains an optional external relay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Provider OAuth renewal      | `POST /v1/provider/{providerId}/oauth/authorize`                                                                                                             | Optional `{ "force": true }` starts a fresh login even while old credentials remain connected. Provider inventory reports `oauthPending` separately from `authStatus` so clients can wait for the new flow without mistaking old credentials for completion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

OpenAPI named schemas (not generic objects) for the new product types: `HomelabCapability`, `CapabilityInvokeResult`, `CapabilityRun`, `CapabilityRunList`, `DiagnosisResult`, `ActivityItem`, `ActivityDiagnosisItem`, `ActivityRunItem`, `ActivityWorkerItem`, `ActivityBackgroundTaskItem`, `ActivityList`, `ProductGoal`, `ProductGoalRun`, `ProductWorker`, `ProductBackgroundTask`, `ProductBackgroundTaskResource`, `PendingPermission`, `PermissionResolution`, `Skill`, `McpServer`, `McpTool`, `EnabledResource`, `AgentArtifact`, `ArtifactList`, `ArtifactContent`, `PermissionModeSettings`, `AgentSettings`, `AgentSettingsPatch`, `AuditRecord`, `AuditList`, `DeviceRegistration`, `DeviceRegistrationList`, `DeviceRegistrationRequest`.

## Explicit non-ships (leftover)

These are **not** deferred accidentally. They are out of this slice:

- **App contract adoption for the shipped surfaces is done.** `ThebeCoreClient` covers capabilities and runs, Activity (including source/status/time filters and cursors), Goals, Workers, pending permissions, Skills, MCP lifecycle, enabled resources, permission mode, Agent settings, Artifacts, audit detail, background-task stop, and push-device registration. Empty protocol defaults in that file are test doubles and the disconnected-client fallback. A future provider-specific screen is new work, not a hole in this client.
- **Provider-native background tasks.** OpenList, Arcane and qBittorrent discovery/control are wired in `bootstrap.ts`. Each Activity read calls `provider.list()`, so Core recreation does not drop provider tasks. They do not use the capability-run `recovery` field. Terminal providers can supply their own output through the bounded `task_output` Artifact seam. Direct/background capability results remain `report` Artifacts. Operation receipts, Diagnosis runs, enabled-resource snapshots, Goal/Worker reports, Pi detached Bash discovery, and runtime-recreation recovery for Core-owned snapshots remain implemented. qBittorrent completion output and the additional task source close the two previously identified code gaps; deployment and real-provider acceptance are separate checks.
- **Goal identity rewrite** and `GET /v1/goals/{id}/runs`.
- **Replacing raw `/mcp`**. The product server enable/disable seam is now available; raw JSON-RPC remains an integration compatibility surface.
- **Skill file editing**.
- **Chat-tool `/v1/approvals` collection.** Diagnose-restart Approval/Receipt stays on `GET /v1/activity`. Runtime tool confirmations are `/v1/permissions`. `CORE-ITERATION-PLAN.md` P0.4 suggested `/v1/approvals`; that name was rejected so it does not compete with Activity (ADR 0011 / 0013).
- Workers HTTP uses plural `/v1/subagents` (plan examples also allowed `/v1/subagent`).
- Session-scoped background-task HTTP is unchanged and is not a Worker product.
- Media/Emby/Immich **App** connections. Core already has media read capabilities and adapters.

## Composable service APIs (2026-10-07)

The execution primitives are `service_api_discover`, `service_api_read` and
`service_api_write`, alongside Core's `bash`, `read`, `edit`, `write` and dynamic
MCP tools. There is no compiled service operation catalog or fixed workflow.
New services require connection configuration, and new operations come from the
service's schema rather than new tool implementation code.

Set `THEBE_SERVICE_APIS` to a JSON array:

```json
[
  {
    "id": "any-service",
    "baseURL": "http://service:8080",
    "openapiPath": "/openapi.json",
    "headersEnv": { "X-API-Key": "SERVICE_API_KEY" },
    "readOperations": ["GET /jobs/{id}"]
  }
]
```

`baseURL` is the API request root (including a reverse-proxy or API prefix).
`openapiPath` is appended to that root. Omit it to probe `/openapi.json`,
`/swagger.json`, `/api/openapi.json`, and `/swagger/v1/swagger.json`. JSON OpenAPI
3.x and Swagger 2.0 are supported. `headersEnv` maps HTTP header names to existing
environment variables; for Bearer authentication the variable's value includes
the `Bearer ` prefix. Credentials stay in the adapter. Existing
`THEBE_OPENLIST_BASE_URL` / `THEBE_OPENLIST_TOKEN` and CloudSaver equivalents remain
connection shortcuts; explicit generic entries override same-named shortcuts.
App connections are independent and are not automatically copied to Core.

Configured service API tools also appear in the capability/MCP tool inventory,
with read versus confirmation permissions. Skill/resource enable, update and
remove refresh idle conversations immediately; busy conversations pick up the
new resources before their next prompt. MCP server toggles use the same reload
boundary. No new conversation is required.

Enabled MCP tools are declared directly to the model, including their input
schemas. There is no `tool_search` discovery call or empty-search result in the
execution flow. Enabling or disabling a server updates this direct tool set at
the existing session reload boundary; write approvals remain in effect.

Permission preflight applies remembered decisions and the current permission
mode before emitting approval events. Full-access and remembered approvals do
not produce transient approval cards; explicit denials, read-only restrictions
and critical command policy still win. Ask mode continues to request approval
for commands that have not been approved. To approve Bash for the conversation,
use the tool-scoped remembered decision rather than approving each command.

Discovery searches live operation IDs, paths, descriptions and tags using `query`,
pages with `offset`/`limit`, and loads parameters, request bodies and response
schemas with `operation_id`. Internal JSON `$ref` references are resolved with
cycle/depth/expansion bounds. `refresh:true` reloads a changed schema immediately;
otherwise the cache lasts five minutes. Each service reports its own discovery
failure, so an unavailable service does not hide other connections. API descriptions
are untrusted data; schema server URLs do not override the operator's base URL.

Approved requests support arbitrary relative paths and JSON/text/form bodies
(`body`, `content_type`). A missing OpenAPI does not disable approved requests:
the agent can inspect vendor docs or code with Core coding/MCP tools, generate
a script, and execute it through the existing runtime. It must not invent request
schemas, execution results or task completion. API calls are not limited to a
particular service name, `/api` prefix, or named runbook.

Sensitive response values become opaque references. `privateValueReferences`
contains JSON pointers and reference IDs; later request bodies can reuse them as
`{"$thebeValueRef":"reference"}`. The adapter substitutes the private value just
before sending, binds it to the same connection, caps retained references and
expires them after ten minutes. This supports chained authentication/transfer
operations without bespoke token-handling code for each vendor.

New operations require runtime approval unless trusted operator `readOperations`
marks their operation ID or `METHOD /path/template` read-only. Remote schema
annotations cannot grant approval. Arbitrary hosts, traversal and redirects are
blocked. Direct HTTP/MCP `invokeTool` writes are rejected; use an agent session
and its pending permission flow. Remembered write approvals default to the exact
arguments. Core permission modes are `plan`, `manual`, `acceptEdits`, and `bypassPermissions`.

### How to tell the two approval objects apart

| Object                      | HTTP                                                                 | Origin                                                                         |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Activity Approval / Receipt | `GET /v1/activity`, `POST /v1/action`, `POST /v1/activity/{id}/deny` | Diagnose-restart; one id mutates Approval → Receipt                            |
| Runtime pending permission  | `GET /v1/permissions`, session permission resolve                    | In-prompt tool confirmation (`bash` / `write` / `edit`, …); redacted args; TTL |

## Raw `/mcp` contract

`POST /mcp` is a stateless JSON-RPC endpoint (protocol `2025-06-18`, `tools` only; no resources or prompts).

- `tools/list` returns each tool with standard `annotations`: `readOnlyHint` and `destructiveHint` come from Core's own `effect`/`risk` classification (never from a remote server's claims), and `openWorldHint` is true for external or public-web tools. Thebe extras are namespaced under `_meta`: `thebe/category`, `thebe/resourceKinds`, `thebe/approval`. No `outputSchema` is advertised yet.
- `tools/call` returns text `content` (the universal fallback) and, when the result is a JSON object, the same data as `structuredContent`.
- A tool that ran and failed, or rejected its input (including writes that need runtime approval), returns `result.isError: true` with the message as text. Only a failure of the request itself is a JSON-RPC error: `-32602` for an unknown tool, `-32000` when no agent service is attached, `-32003` while quiesced.


## Owner instructions (2026-10-14)

`instructions` on `GET/PATCH /v1/settings/agent` is the owner's standing instruction text, the counterpart of the global `AGENTS.md` / `CLAUDE.md` that Codex, dsh and Claude Code load. Core adds it to the system prompt after its built-in rules, inside an `<owner_instructions>` block that says it cannot relax approval, workspace, sandbox or safety rules.

- **Limit**: 4 096 UTF-8 bytes (about 1 000–1 400 tokens, 4–5% of the 28 672-token input budget a client assumes when a model's window is unknown). Over the limit is `400` with the size in the message; nothing is cut off silently. Line endings are normalized to `\n` and surrounding space is trimmed. Empty text clears them. A stored file edited by hand beyond the limit is cut to fit on load.
- **When it applies**: the prompt is read when a session is opened. A change reaches sessions opened afterwards; a session that is already open keeps the prompt it started with, so its provider cache stays valid. A session reopened after a restart is built again, so a change made in between rebuilds its cache once.
- **Cache**: with no instructions set, the prompt is byte-for-byte the one Core sent before this setting existed. With them set, they are appended after the built-in prompt, so the leading bytes are unchanged. Changing other settings never touches the prompt. Tests: `src/agent/settings/instructions.test.ts`.
- **Audit**: each change records `settings.instructions` with the hash and byte size only, never the text.
- Subagents use their own profile prompts and do not receive the owner instructions.

## Thebe Memory (2026-10-14)

Short durable facts the model saves with the `memory` tool and the owner can read, edit and delete. Shaped after Hermes' memory (two stores, add / patch / remove, a size limit checked on the final result, frozen into the system prompt when a session starts) and Claude Code's rule to keep only what cannot be found again.

- **Stores**: `user` (who the owner is, 1 536 bytes) and `notes` (stable facts about their setup and conventions, 2 560 bytes). Together 4 096 bytes, the same budget as the owner instructions; each is counted as the rendered `- entry` list in UTF-8 bytes. One entry is one line.
- **The tool**: `memory {target, operations:[{action: add|patch|remove, content?, old_text?}]}`. A batch applies atomically and the limit is checked on its final result, so one call can drop stale entries and add new ones. `old_text` picks an entry (an exact entry wins, otherwise the one entry containing it; unclear picks are refused). It **requires approval** like `bash`/`write`/`edit`. The description tells the model when to save and, as much, when not to.
- **What is refused**: invisible/bidirectional characters, prompt-injection and exfiltration phrasing (Hermes' "all" and "strict" patterns, trimmed), forged `<memory>` / `<owner_instructions>` / `<tool_output>` tags, and anything the output redactor would redact (credentials). The prompt also labels memory as background data that cannot relax approval or safety rules.
- **When it applies**: the memory is read when a session is opened and appended after the built-in prompt and the owner instructions. A write during a session is saved at once and reaches the **next** session; the open session keeps the prefix its provider cache holds.
- **Cache**: with no memory store configured nothing changes (no tool, no section). With an empty memory the system prompt is byte-for-byte what it was; the only change is that `memory` is one more tool in the tool list, the same in every session whether memory is empty or full. Tests: `src/agent/memory/memory.session.test.ts`.
- **Routes**: `GET /v1/memory` returns `{enabled, memory:{user,notes}}` with each store's `entries`, `usedBytes`, `limitBytes`. `POST /v1/memory/operations {target, operations}` is the owner's edit: same operations, no approval, `400` with the reason when refused, `404` when memory is not enabled.
- **Storage and audit**: `memory.json` beside `config.json`, written through a rename; writes are serialized. Each change records `memory.tool` or `memory.edit` with a hash of the operations and the result, never the text.
- Subagents get no memory tool and no memory section.
