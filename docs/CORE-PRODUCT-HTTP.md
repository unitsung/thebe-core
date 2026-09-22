# Core product HTTP — shipped vs leftover

Date: 2026-09-22.

This page records the product HTTP surfaces shipped on `dev`. Delivery still only calls `ThebeAgent`; raw `/mcp` remains unchanged for integrations. Remaining durable product work is tracked in [Core issue #4](https://github.com/unitsung/thebe-core/issues/4).

## Shipped

| Surface | HTTP | Notes |
| --- | --- | --- |
| Capability discovery | `GET /v1/capabilities` | Product metadata: category (`files`, `media`, `downloads`, `containers`, `automation`, `diagnostics`, `compute`, `storage`, `network`, `photos`, or `other`), provider/source/service, permission, `resourceKinds`, `execution`, `background`, `destructive`, `outputKind`. |
| Capability invoke | `POST /v1/capabilities/{id}/invoke` | Through `ThebeAgent.invokeCapability` → policy/tools. Direct `{ type: result }` or background `{ type: run, runId }`. `container.restart` and `approval=required` return 403; use `POST /v1/action`. |
| Capability run | `GET /v1/capabilities/runs`, `GET /v1/capabilities/runs/{runId}`, `GET /v1/capabilities/runs/{runId}/log` | Durable snapshots under `{agentStoreDir}/capability-runs`; terminal runs and results survive Core recreation. Recovered terminal snapshots expose `recovery: restored`; queued/running runs owned by an older Core instance expose `status: interrupted`, `recovery: interrupted`, and an interruption error. Capability runs are never silently resumed. The log route returns the current snapshot as JSON by default or `capability_update` SSE snapshots when `Accept: text/event-stream` is requested. |
| Activity feed | `GET /v1/activity`, `GET /v1/activity/{id}` | Typed union of Approval, Receipt, Goal, Capability Run, Worker, and Core-owned Background Task items. Supports `group`, `source`, exact `status`, inclusive `updatedAfter`/`updatedBefore`, bounded `limit`, and opaque `cursor`/`nextCursor`; filtering happens before pagination and ordering is stable by `updatedAt` plus id. Capability Runs keep their source `runId`, Workers keep their `ProductWorker` source link without the parent transcript, and Background Tasks keep their source task id plus parent session id. Pi detached Bash task snapshots survive runtime recreation and are stopped through the registry. Queued/running items are `running`, terminal items are `recent`. |
| Goals | `GET/POST /v1/goals`, `GET /v1/goals/{id}`, `POST .../pause`, `POST .../resume`, `POST .../stop`, `GET .../log` | Durable ProductGoal attached to one parent session. A terminal Goal with an isolated worker/reviewer report links a bounded `report` Artifact through `artifactId`; Goal state and report Artifacts survive Core recreation. `updatedAt` advances with lifecycle events so Activity ordering and time filters remain useful while work is running. |
| Workers | `GET/POST /v1/subagents`, `GET /v1/subagents/profiles`, `GET /v1/subagents/{runId}`, `POST .../cancel`, `GET .../log` | Product object is `ProductWorker` mapped from `SubagentRun`. No parent transcript. The log route returns bounded JSON activity by default or sanitized `worker_update` SSE snapshots when `Accept: text/event-stream` is requested. |
| Runtime pending permissions | `GET /v1/permissions`, `GET /v1/permissions/{id}`, `POST /v1/permissions/{id}/resolve` | Redacted tool input. Remember scopes: request/tool/conversation. **Not** Activity Approvals. Session `POST /v1/session/{id}/permission/{permissionId}` remains. |
| Skills | `GET /v1/skills`, `GET/PATCH /v1/skills/{name}` | List/get/enable/disable. No skill-file body, no editor. |
| MCP inventory and lifecycle | `GET/PATCH /v1/extensions/mcp/servers/{name}`, `GET /v1/extensions/mcp/tools` | External tools only. Server enable/disable state persists through the Thebe config and is applied when the MCP registry is recreated. Raw `/mcp` stays for integrations; advertised Core capabilities remain callable there through the Agent seam with the same typed-resource validation. |
| Enabled resources | `GET /v1/resources/enabled`, `PUT/DELETE /v1/resources/enabled/{id}`, `POST /v1/resources/enabled/artifact` | Agent context resources (`skill` / `extension` / `prompt`), not an App Resource DB. Selections persist through the Thebe config across Core recreation; the explicit POST captures a bounded `resource_list` Artifact. |
| Permission mode | `GET/PATCH /v1/settings/permissions` | `ask` \| `read-only` \| `full-access`. |
| Agent settings | `GET/PATCH /v1/settings/agent` | Effective auto-compact/summary settings, bounded delay, permission mode, concurrency limits, and guarded paths. Mutable fields are auto-compact/summary/delay; concurrency changes report `409 restart_required`. Each value includes a `sources` entry and the response reports `persistence.enabled`. |
| Artifacts | `GET /v1/artifacts`, `GET /v1/artifacts/{id}`, `GET /v1/artifacts/{id}/content` | Bounded Core-owned metadata/content with kind, session/run/resource links, filters, atomic persistence, server-side redaction, and bounded retention. Operation receipts, Diagnosis runs, enabled-resource snapshots, completed background Capability Runs, terminal Goal reports, and terminal Worker reports are producers. |
| Audit log | `GET /v1/audit`, `GET /v1/audit/{id}` | Read-only redacted records with bounded pagination, filters, and stable detail lookup; raw parameters are never returned. |
| Push device registration | `GET/POST /v1/devices`, `DELETE /v1/devices/{registrationId}` | Durable, token-redacted iOS registrations with notification categories, stable token-derived ids, and de-registration. APNs delivery remains an optional external relay. |

OpenAPI named schemas (not generic objects) for the new product types: `HomelabCapability`, `CapabilityInvokeResult`, `CapabilityRun`, `CapabilityRunList`, `DiagnosisResult`, `ActivityItem`, `ActivityRunItem`, `ActivityWorkerItem`, `ActivityBackgroundTaskItem`, `ActivityList`, `ProductGoal`, `ProductGoalRun`, `ProductWorker`, `ProductBackgroundTask`, `PendingPermission`, `PermissionResolution`, `Skill`, `McpServer`, `McpTool`, `EnabledResource`, `AgentArtifact`, `ArtifactList`, `ArtifactContent`, `PermissionModeSettings`, `AgentSettings`, `AgentSettingsPatch`, `AuditRecord`, `AuditList`, `DeviceRegistration`, `DeviceRegistrationList`, `DeviceRegistrationRequest`.

## Explicit non-ships (leftover)

These are **not** deferred accidentally. They are out of this slice:

- **Remaining App contract adoption** is limited to broader cross-product hardening and future provider-specific surfaces. The current App client covers capabilities and runs, Activity, Goals, Workers, pending permissions, Skills, MCP lifecycle, enabled resources, permission mode, Agent settings, Artifacts, audit detail, and push-device registration management.
- **Additional Artifact producers and provider-native background-task sources** — Operation receipts, Diagnosis runs, enabled-resource snapshots, Goal reports, Worker reports, Pi detached Bash discovery, and runtime-recreation recovery are implemented at the Core adapter seam; other provider-native task sources remain future producers.
- **Goal identity rewrite** and `GET /v1/goals/{id}/runs`.
- **Replacing raw `/mcp`**. The product server enable/disable seam is now available; raw JSON-RPC remains an integration compatibility surface.
- **Skill file editing**.
- **Chat-tool `/v1/approvals` collection.** Diagnose-restart Approval/Receipt stays on `GET /v1/activity`. Runtime tool confirmations are `/v1/permissions`. `CORE-ITERATION-PLAN.md` P0.4 suggested `/v1/approvals`; that name was rejected so it does not compete with Activity (ADR 0011 / 0013).
- Workers HTTP uses plural `/v1/subagents` (plan examples also allowed `/v1/subagent`).
- Session-scoped background-task HTTP is unchanged and is not a Worker product.
- Media/Emby/Immich **App** connections. Core already has media read capabilities and adapters.

## How to tell the two approval objects apart

| Object | HTTP | Origin |
| --- | --- | --- |
| Activity Approval / Receipt | `GET /v1/activity`, `POST /v1/action`, `POST /v1/activity/{id}/deny` | Diagnose-restart; one id mutates Approval → Receipt |
| Runtime pending permission | `GET /v1/permissions`, session permission resolve | In-prompt tool confirmation (`bash` / `write` / `edit`, …); redacted args; TTL |
