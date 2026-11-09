# Thebe Core

The homelab Agent and capability plane. The Pi runtime owns the reasoning loop behind the `AgentRuntime` interface; this repo does not write a second one. Core turns user intent into discoverable homelab capabilities, normalized events, safe operations, and auditable task results. Service-specific behavior belongs in built-in adapters or external plugins/MCP integrations.

## Language

**Tool name**:
One name for one capability, `<service>_<action>` in lower-case snake case (`container_list`, `download_delete`, `navidrome_playlist_update`). The same string is the capability id over `/v1/capabilities` and `/mcp`, the tool the model calls, and the name in prompts and the approval prompt. The part before the first underscore is the service a Ticket's Mandate is checked against; the generic `service_discover`, `service_read` and `service_write` take the service as an argument. No dotted ids, and no second name for the model. Names that an external MCP server provides are translated once, at the Pi boundary.
_Avoid_: dotted ids (`container_list`), `service_api_*`, one name for clients and another for the model

**Thebe Core**:
This repository and the Agent it is. Package and repo name are `thebe-core`. It replaces `core_v0`, an earlier repository that has been deleted; nothing here depends on it, and it is not a version of this one.
_Avoid_: thebe-agent-core, Thebe Agent Core, core_v0 (the deleted predecessor, not a release line), a dashboard proxy with no Agent

**Source**:
An enabled background event stream in `src/agent/sources/`, configured by `THEBE_SOURCES`. `container-health` observes container states; `download-completed` observes configured download engines and requires a `DownloadProvider`. The first read establishes a baseline, the cursor persists, and a partial multi-engine listing fails without advancing it. A Source emits immutable `Trigger`s on resource `Thread`s (`resource:container:<name>`, `resource:download:<engine>:<hash>`). `GET /v1/health` reports enabled Sources with `starting` / `healthy` / `failing`, `consecutiveFailures`, and the latest error; a successful read clears the failure count.
_Avoid_: replaying existing state at startup, advancing a cursor after a partial read, or silently omitting a configured Source whose provider is missing

**Eval**:
`src/agent/eval/` applies a deterministic Gate and then asks the Policy's assessment model about eligible Triggers. A container going down gets a best-effort, read-only diagnosis; a completed download gets a current-state recheck and read-only searches of configured media libraries. The bounded evidence goes to the Assessment and, if accepted, the Executor; ignored preparation creates no Artifact, Activity, approval, or other user attention. Its `Decision` is `accept`, `ignore`, or `unavailable`; observe records what Core would have taken on, while auto creates the Ticket. A provider error, unusable reply, or hourly assessment limit is `unavailable`, never a no. Core pushes one notice for an assessment outage and re-arms it only after a successful assessment.
_Avoid_: treating a failed assessment as "nothing to do", or pushing every Trigger while the same outage continues

**Ticket**:
An authorised unit of work in `src/agent/tickets/`. Created by a decision: a person asking (`direct`, through `POST /v1/goals`, `POST /v1/tickets` or `/mcp`), or Eval taking on an event under the person's policy (`eval`). Its id is derived from its content, so the same request or event produces the same Ticket; HTTP and `/mcp` delegation use the caller's stable `idempotencyKey`, so a retry after timeout or restart returns the same Ticket and Goal. Goals persisted before Tickets existed are backfilled once per Core process as `direct` migration Tickets keyed by `legacyGoalId`. A Ticket wraps existing objects (a Goal keeps its own id, status, report, receipt, permissions, and attention); its stage is derived on every read and not stored.
A Ticket subscribes to resource threads (`subscriptions`). While the Ticket is open, subsequent events on those threads are fanned out to it directly as `inputs` (`seq`, `source`, `kind`, `thread`, `at`, `attachedAt`), skipping Eval and model prompts entirely (0 tokens). An ended Ticket stops receiving inputs.
Before paused work resumes, an `eval` Ticket is revalidated against the current Policy, enabled Source and resource wiring. A failed check leaves it paused and writes a denied `ticket.mandate_revalidate` audit record; it never starts another worker. A `direct` Ticket is the person's explicit request and does not depend on the current Policy.
Over `/mcp`, `ticket_list` and `ticket_get` read the derived view; `ticket_delegate` creates the direct Ticket and Goal, `ticket_reply` answers Attention or decides one pending worker permission, and `ticket_control` pauses, resumes or stops the Goal. Delegation, reply and control are writes gated by `THEBE_MCP_WRITES` and `mcp:write`; arbitrary `bash` approval and irreversible calls need `mcp:irreversible`. The person-facing HTTP controls are `POST /v1/tickets`, `POST /v1/tickets/{id}/reply`, and `POST /v1/tickets/{id}/pause|resume|stop`; they share the same control module and are refused while quiesced.
_Avoid_: treating Ticket as a duplicate of Goal, storing derived status or stage on Ticket, or running Eval for events on threads with an open Ticket

**AgentRuntime**:
Agent-owned runtime Interface in `src/agent/runtime`. Delivery code imports the Agent Interface; the Pi adapter implements this boundary. It is a structural seam, not a claim that a second runtime is integrated.
_Avoid_: a top-level runtime grab bag, AgentAdapter, raw `Agent`/`AgentHarness`, Pi session objects in Agent or delivery code

**CommandRisk**:
Homelab/NAS command heuristics in `src/agent/security/command-risk.ts`: `assessCommand`/`assessToolCall` grade a tool call `safe`/`caution`/`dangerous`/`critical` (storage systems, NAS volumes, disk writes, container breakouts, workspace escape) and the agent's permission preflight denies `critical`, asks for `dangerous`. Container commands get their own guard (`docker-command-guard.ts`), and Docker Engine API calls issued straight at `docker.sock` (curl/podman) go through `docker-api-guard.ts`. The layer is always on; only `bypassPermissions` lifts it, for one session.
_Avoid_: blocking inside the adapter instead of the preflight

**PermissionMode**:
The one setting that decides how much a session may do without asking: `plan` (read-only), `manual` (ask each time), `acceptEdits` (workspace edits and sandboxed commands run unasked), `bypassPermissions` (nothing asked, command guard and sandbox lifted). Names are Claude Code's; the rules for `acceptEdits` follow Codex's on-request policy with a restricted sandbox (`src/agent/security/accept-edits.ts`). Stored per session as `AgentSessionMeta.permissionMode`, the host default in `config.json`; `bypassPermissions` is always selectable; the TUI and graphical clients ask before turning it on, and `THEBE_FULL_ACCESS` is ignored. A session's own mode is never inherited by subagents, schedules, background goals, `/mcp` callers, or non-interactive turns. Only the four names are read.
_Avoid_: a second permission-mode name, a remote-controlled switch for `bypassPermissions`, command-safety lists (the sandbox is what makes running unasked acceptable)

**OsSandbox**:
Host bash isolation in `src/agent/security/os-sandbox.ts`, pinned to `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, bubblewrap on Linux). A container (`/.dockerenv` or `/run/.containerenv`) does not start it. On a host it is on unless Agent settings set `sandboxEnabled` false, `THEBE_SANDBOX=off`, or that session is in `bypassPermissions`. `SandboxManager.initialize` runs once per process; `wrapWithSandbox` runs inside the async bash `exec`. Pi's `spawnHook` only sanitizes the environment. Writes are the workspace and the temp directory; reads are open except `~/.ssh`, `~/.aws`, `~/.gnupg` and `~/.thebe`. The network allowlist starts empty; a host that matches nothing asks through the session permission prompt, and remembering it saves the host. Missing dependencies refuse the command. Any `THEBE_SANDBOX` value other than `off` is ignored, the same as leaving it unset. `bootstrapThebe().disposeSandboxVms` resets the proxies.
_Avoid_: a backend menu, nesting this sandbox inside the release container, wrapping the command in the synchronous spawn hook, a Pi sandbox extension

**PiCodingAgentRuntime**:
First `AgentRuntime` implementation. Embeds `@earendil-works/pi-coding-agent` via `createAgentSession`. Must not spawn the Pi CLI.
_Avoid_: depending on Pi types outside `src/adapters/pi`, wrapping the Pi CLI

**Pi version pin**:
`@earendil-works/pi-coding-agent`, `pi-mcp`, `pi-tui` (dependencies) and `pi-ai` (dev) move together (currently `^1.2.0`, locked in `package-lock.json`); bump all four in one change and run `node scripts/check-pi-resolution.mjs`. Pi's dist is loaded by URL from its own `node_modules` (`src/adapters/pi/sdk/load-pi.ts`), including `pi-ai` for providers that need its helpers, so Core never depends on pi-ai directly and never bundles a second copy. Provider streams receive a normalized transcript (`getCurrentSystemPrompt` / `getCurrentTools`), not `context.systemPrompt`/`context.tools`.
_Avoid_: bumping one Pi package alone, importing pi-ai outside `src/adapters/pi`, reading `context.systemPrompt` in a provider

**MCP Integration**:
External MCP servers (command- or URL-based) are configured in `.thebe/mcp.json`. A model session connects them through the Pi runtime's built-in MCP extension and `codemode`, with Core supplying configuration and the policy, approval, audit and redaction hooks (`src/adapters/pi/session/mcp-extension.ts`); Core writes no second MCP client for model calls. `src/adapters/mcp` is the product inventory outside a session (configured servers, tool lists, capability calls) and uses Pi's `@earendil-works/pi-mcp` client. The Agent owns the stable MCP extension Interface in `src/agent/extensions/mcp`, and HTTP/TUI expose it through `src/delivery`.
_Avoid_: putting Agent runtime, HTTP routes, TUI commands, or homelab business state inside the MCP Adapter; treating server names as the product API

**HomelabCapability**:
User-facing unit of work exposed by an integration, such as file search, media search, download submission, container inspection, service health, or task scheduling. A capability carries a stable name, input/output schema, target service instance, health/error state, and permission level.
_Avoid_: exposing raw vendor endpoints as the only client contract, or requiring the UI to know which MCP server implements a capability

**IntegrationPlugin**:
The service-specific boundary that supplies one or more `HomelabCapability` implementations. A plugin may be a built-in adapter or an external MCP server; it owns credentials, vendor API details, and idempotency while Core owns discovery, policy, task orchestration, normalized events, and audit. Prefer the provider's own MCP server for vendor service coverage; add a built-in adapter only when Core owns cross-cutting semantics the MCP boundary cannot express (the approval → execute → verify → receipt action path, e.g. containers and diagnosis).
_Avoid_: putting a new agent loop in each plugin, hard-coding every third-party service into Core as more `vendor.tool` modules, or auto-enabling untrusted code

**ServiceCoverage**:
How a vendor service reaches the model, in preference order: (1) the provider's own MCP server (`.thebe/mcp.json`: `url` + `headers`, or `command` + `env`; also reachable from the TUI and `thebe mcp`); (2) `service_discover` / `service_read` / `service_write` over the service's own OpenAPI 3 / Swagger 2 document — whose operator allow-listed read operations are each also exposed as their own MCP tool (`service_api.<id>.<operationId>`), still with no per-vendor code; (3) a built-in adapter — only with a reason Core owns. Which services actually ship an MCP server today is recorded in `docs/PROVIDER-MCP.md`. Built-in adapters exist today for: containers (`Arcane`, or the Docker Engine proxy via `docker-socket-proxy`) because the write runs on Core's approval → execute → verify → receipt path; the acquisition pipeline (`DownloadProvider` qBittorrent and aria2 behind one hub, `CloudTransferProvider`/`FilesProvider` OpenList, Prowlarr release search, Emby/Jellyfin library refresh) because Core owns its durable job state machine, bounded retries, and background advancer rather than a single request/response; and read-only media/photo/music observation (Emby, Jellyfin, Immich, Navidrome) that shipped before this rule. Radarr, Sonarr, Lidarr, Prowlarr's own management, Jellyseerr, Plex, Proxmox, and TrueNAS are reached through a provider MCP server or `service_api_*`, not new `vendor.tool` modules.
_Avoid_: writing a built-in adapter for a service that already publishes an MCP server or an OpenAPI document; adding `src/agent/capabilities/<vendor>.ts` or `vendor.*` tools per service; treating shipped read adapters as a precedent for new ones; bundling a third-party MCP server (the operator installs it; `docs/PROVIDER-MCP.md` says which clear the quality bar)

**RuntimeSession**:
One runtime-backed conversation. Create, resume, list, fork (including at a message), compact, export, steer, follow-up, model selection, and revert are runtime facilities.
_Avoid_: Thebe-owned transcripts, branch stores, or local HTML/JSONL exporters

**NormalizedEvent**:
The only event shape clients see (`text_delta`, `tool_start`, `tool_end`, `session_end`, `interrupted`, `queue_update`, `permission_requested`, …).
_Avoid_: Pi `AgentSessionEvent`, `assistantMessageEvent`, harness hook payloads

**AgentStore**:
Thebe persistence for Agent metadata only: `thebeSessionId`, `runtimeId`, `runtimeSessionId`, title, timestamps, selected context, labels, share metadata, remembered permissions.
_Avoid_: storing transcripts, branch topology, compaction records, or OAuth refresh tokens

**Prompt**:
One user turn through the Thebe Agent into a `RuntimeSession` (`ThebeAgent.prompt()`). Modes are `prompt`, `steer`, and `followUp`. `send()` is a compatibility alias.
_Avoid_: naming this Ask, a second agent loop, a parallel Thebe CLI suite

**Main Session**:
The one durable person-facing Session owned by a Core, with the stable id `thebe-main`. It starts lazily, resumes its runtime transcript after a restart, and is exposed by `GET /v1/main-session` and `POST /v1/main-session/messages`. It has no shell, file, or edit tools. Its read-only `session_search` tool searches or reads earlier person-facing Core Sessions without changing the active conversation; its remaining tools inspect and control Tickets (`ticket_list`, `ticket_get`, `ticket_delegate`, `ticket_reply`, `ticket_control`). The three Ticket writes use the normal session approval handler, and recalled Session text, Ticket inputs, and tool output remain untrusted data that cannot broaden a Mandate. Existing Session routes can still inspect the same conversation, but Ask Thebe and other entry points must not create a second main Session.
Delegation through the main Session is a direct request from `chat`, with its own stable idempotency namespace; it is not attributed to an `/mcp` caller.
_Avoid_: one main Session per client, inheriting executor tools, letting the main Session approve a worker action on behalf of the person, or duplicating Ticket state into the Session.

**TUI**:
`@earendil-works/pi-tui` (`TuiMainScreen`, `Editor`, `Markdown`, `Text`). Start with `node dist/tui.js`. Prompt is the agent turn; this package is the terminal.
_Avoid_: a homegrown renderer, a Thebe-written web chat

**Serve**:
Thin HTTP listener. Session API is `/v1/session` (create, prompt, messages, log SSE, interrupt, permission), with the one durable main Session at `/v1/main-session` (lazy read, message, interrupt). Product Goal API is `/v1/goals` (create, list, get, pause/resume/stop, log JSON/SSE) with session-scoped aliases under `/v1/session/{id}/goal`. Capability API is `GET /v1/capabilities` and `POST /v1/capabilities/{id}/invoke` (Agent-mediated; `container_restart` stays on `POST /v1/action`). Worker API is `/v1/subagents`. Runtime pending permissions are `/v1/permissions` (not Activity Approvals). Skills `/v1/skills`, MCP inventory `/v1/extensions/mcp/*`, enabled resources `/v1/resources/enabled`, Artifacts `/v1/artifacts`, permission mode `/v1/settings/permissions`. Client compatibility: `/v1/health`, `/v1/event(s)`, `/v1/devices`, `/v1/messages` (JSON auto-denies approvals; SSE with `Accept: text/event-stream`), `/mcp`, and the optional OAuth gateway endpoints. Default bind `127.0.0.1:8787`; logs print both the local URL and `bind=host:port`. Host allowlist always includes loopback; `THEBE_HOST=0.0.0.0` still requires `THEBE_ALLOWED_HOSTS` for LAN Host headers. `NODE_ENV=production` requires `THEBE_TOKEN` (sent as `X-Thebe-Token` or `Authorization: Bearer`). `POST /v1/system/quiesce` is admin-equivalent (token is the only gate) and blocks mutating writes except interrupt/permission. Credential PUT/POST is plaintext HTTP; production should sit behind Tailscale or an HTTPS reverse proxy. SIGTERM/SIGINT drain via `agent.quiesce()` then `server.close`. HTTP body cap 10MB. Default session idle reap is 30 minutes (`THEBE_SESSION_IDLE_TIMEOUT_MS=0` disables).
_Avoid_: a second agent loop, an MCP marketplace as the product, APNs as a Core concern, or exposing raw plugin internals as the client contract

**Tool Layer**:
Thebe custom capability surface. Built-in v0 capabilities include `container_list` / `container_inspect` / `container_logs` / `container_status_summary`; external integrations can add file, media, download, scheduling, and service-specific capabilities through MCP. Redaction is internal and runs before results enter runtime history.
_Avoid_: a second allow-list in config or flags, treating redaction as its own module, or making the built-in container set the product boundary

**DiagnosisRun**:
Product-facing read-only diagnosis (`POST /v1/diagnosis`). A client sends a typed `ResourceRef`; Core gathers bounded observations from container capabilities, optionally reasons, and returns `resource`, `observations`, `diagnosis`, `recommendations`, `runId`, and `actionId`. Observed facts come from tools/providers only. Write recommendations carry `actionId` but are not executed here.
_Avoid_: exposing raw MCP `tools/call` as the client contract, dumping inspect/logs/agent state to the client, or concatenating display names into prompts

**ActionReceipt**:
Product object for an approved write. Slice 02 is only `container_restart`: on-device approval → deterministic provider restart → programmatic verification (`state==running`, Emby health when applicable) → receipt. Metadata `effect=write`, `risk=disruptive`, `approval=required` lives in `CONTAINER_CAPABILITY_METADATA`. The chat model cannot approve, execute, or grade verification.
_Avoid_: attaching `container_restart` to the chat tool loop, auto-executing from diagnosis, or letting a client call raw MCP for writes

**AgentArtifact**:
Core-owned bounded product result with stable `artifactId`, allow-listed kind,
title, optional session/run/resource links, timestamps, content type, and byte
size. Metadata and redacted content are stored separately with safe ids,
atomic writes, and bounded retention. Operation receipts, Diagnosis runs,
background Capability runs, terminal Goal reports, and terminal Worker reports
can produce Artifacts;
HTTP reads are `/v1/artifacts` and `/v1/artifacts/{id}/content`.
_Avoid_: arbitrary filesystem paths, unbounded uploads, runtime transcripts,
or treating Artifact metadata as an Activity lifecycle owner

**ActivityRecord**:
Persistence for a pending Approval or a completed Receipt (`GET /v1/activity` returns a typed workspace feed). A diagnosis that recommends restart mints one Approval id; execute mutates that id into a Receipt. Diagnosis without a write recommendation is not stored. `POST /v1/activity/{id}/deny` removes a pending Approval. Stored under the AgentStore directory in an `activity/` subdirectory. `GET /v1/activity` interleaves ProductGoals. Same idempotency key maps to one record. 0 tokens.
_Avoid_: treating this as a full Activity product, naming it the user-facing Activity workspace, dumping raw events, calling the model to summarize the list, or persisting Diagnosis as a sibling row

**ProductGoal**:
Durable objective attached to one parent session. Identity is `thebeSessionId` (`id` === `sessionId`). Product status is `queued` | `running` | `paused` | `succeeded` | `failed` | `cancelled`; runtime `pausing` collapses to `running`. HTTP: `POST`/`GET /v1/goals`, `GET /v1/goals/{id}`, pause/resume/stop, `GET /v1/goals/{id}/log` (JSON or SSE). Session-scoped aliases under `/v1/session/{id}/goal`. Terminal worker/reviewer evidence may be exposed as a linked `report` Artifact. Delivery maps through `toProductGoal` / `toProductGoalEvent`.
A Goal's worker reports through the `goal_report` tool (`src/agent/goals/report.ts`; states progress, ready, blocked, ask, dropped; the text footer is the fallback) and the report is kept on the GoalRun with an optional `attention`: the one open request for the person, a worker's question (`allowAsk`) or a finished result waiting for acceptance (`reviewBeforeDone`). A Goal waiting on the person is `paused` with an `attention`, no new status; `POST /v1/goals/{id}/answer` answers it and a plain resume is `409 attention_open`. A blocker or "nothing to do" report ends the checkpoint before the reviewer runs; `observe` runs use the read-only `goal-observer` profile.
For an Eval-accepted Ticket, the first write the unattended worker requests outside its Mandate is retained by permission control and becomes the deterministic blocker after that worker turn. The Goal ends `failed` with `blocked`, enters Activity as `person` / `blocked`, and never asks the reviewer to judge the worker's completion claim.
_Avoid_: a second Goal id scheme, `GET /v1/goals/{id}/runs`, exposing Pi/MCP/subagent internals, or treating ActivityRecord as a Goal

**Pi built-in tools**:
Runtime-owned `ls`, `find`, `grep`, `read`, `edit`, `write`, `bash` enabled on the same session as `container_*`.
_Avoid_: reimplementing filesystem/bash tools in Thebe

**ContainerInfoProvider**:
The Agent-owned capability declaration in `src/agent/capabilities/containers.ts` for read-only container observation plus the approved `restartContainer` write. Tool Layer and PolicyEngine speak only this Interface; Arcane implements it as an Adapter, and `DockerEngineAdapter` (`src/adapters/docker/adapter.ts`) implements it against the Docker Engine API through a restricted `docker-socket-proxy` (`THEBE_DOCKER_PROXY_URL`) when Arcane is not configured.
_Avoid_: tool code importing a panel SDK, a Docker client, or an HTTP client directly

**Arcane**:
The default container capability provider. Thebe Core does not talk to docker.sock; when Arcane is configured it wins over the Docker Engine API proxy fallback. ArcaneAdapter owns the built-in container surface; other service categories should normally arrive through their integration plugin/MCP boundary.
_Avoid_: ADMIN_STATIC_API_KEY, a homegrown Docker manager, or expanding Core into a vendor-by-vendor service implementation

**NavidromeProvider**:
Agent-owned music capability in `src/agent/capabilities/navidrome.ts`. `NavidromeAdapter` implements the Subsonic API boundary, including salt+MD5 authentication, library/search/artist/lyrics reads, playlist writes, and provider-neutral playback queues with stream/artwork URLs. Core exposes these as `navidrome_*` capabilities; playback, Now Playing and remote commands belong to the client. Playlist writes require the runtime permission flow and are rejected by capability invocation; over `/mcp` they run unless the host sets `THEBE_MCP_WRITES=off`.
_Avoid_: exposing Subsonic credentials to the model, making Core start a mobile playback session, or creating a second player engine

**MediaLibraryProvider**:
Agent-owned Emby and Jellyfin library capability in `src/agent/capabilities/media.ts`. The adapters search and read one item when the composition root supplies the server. Core exposes `emby_search`, `emby_item`, `jellyfin_search`, and `jellyfin_item`. Built-in skills name those tools.
_Avoid_: handing the connection to Pi, inventing a rating the server did not return

**PhotoLibraryProvider**:
Agent-owned Immich capability in the same module. `immich_search` is semantic search through `POST /api/search/smart`. Metadata listing stays a separate read. A machine-learning failure stays an error.
_Avoid_: treating semantic search as a filename filter, or hiding an unavailable search as an empty library

**Download**:
One task on a download engine, in the shape `download_list` returns: `engine`, `id` (a torrent info-hash or an aria2 id), `phase` (`queued`, `downloading`, `paused`, `error`, `completed`), `badges`, `capabilities`, progress, size, speed and ETA. `src/adapters/pipeline/download-hub.ts` puts qBittorrent and aria2 behind the one `DownloadProvider`: links go to the engine that suits them unless one is named, and an id belongs to the engine its shape says. The engine-state → phase table is `contracts/download-states.json`, which a client can run through its own readers. A Download is not an AcquisitionJob: a job is the durable download → place → scan → verify state machine that uses one.
_Avoid_: a second vocabulary of states per engine in the tools, or offering an action the engine does not support for that download (`capabilities` is what it allows)

**AcquisitionJob**:
Durable media-import state machine in `src/agent/pipeline/job-runner.ts`: `submit` → `download` → `place` → `scan` → `verify` → `done`/`failed`, with bounded retries and persisted snapshots (`pipeline_acquire`/`advance`/`status`). Two kinds share it: `torrent` (qBittorrent `DownloadProvider`) and `cloud_transfer`, which fetches a share/direct link through a `CloudTransferProvider` (OpenList offline download) into the file manager before the same place → scan → verify. Providers own credentials and vendor calls; the model chooses the release and folders once.
_Avoid_: putting vendor endpoints in the state machine, a second job runner per service, or running the transfer only while a client is connected

**PipelineAdvancer**:
Agent-owned background loop in `src/agent/pipeline/advancer.ts` that steps acquisition jobs acquired in the running process so they finish without a client (every minute). It never auto-resumes a job restored after a Core restart (that needs an explicit `pipeline_advance`) and stops while quiesced.
_Avoid_: a second scheduler, auto-retrying a failed job, or replaying a restored write-capable job silently

**PolicyEngine**:
Interception and budgets for Thebe custom tools. `decide` is a pure function; `beforeToolCall` is fail-closed. Pi built-ins are not PolicyEngine's concern.
_Avoid_: Gate, Harness, Session, Pi-hook-specific policy wiring, stopping a Run with a terminate field

**StreamGuard**:
Per-Run application timeouts over normalized events: TTFB + idle timers plus an abort watchdog.
_Avoid_: treating upstream timeoutMs as the only backstop, wrapping Pi `StreamFn` in product code

**AuditLog**:
Immutable, append-only, Thebe-Core-writable local JSONL. Redaction at two points (before the model and before disk). Routine cannot disable audit.
_Avoid_: a model-writable audit tool, making audit opt-in

**Raw `/mcp` writes**:
The `/mcp` endpoint lists Core's tools and provider MCP tools for an external agent. Reads always work. Write tools (`container_restart`, the Navidrome playlist writes, a provider tool whose permission is not `read`, and a service API's preview and confirm) run unless the host sets `THEBE_MCP_WRITES=off` (`src/agent/security/mcp-writes.ts`, gate in `invokeMcpTool`). Core does not hold the call for approval: the calling agent and its client ask their user, and every write is audited. A restart goes through the action path, so it leaves a receipt whose approval source is `mcp_client` (a restart from a device is `on_device`) and gets its own idempotency key per call. The client cannot change the switch. A device token made with `thebe token create <name> --scope mcp:read|mcp:write` works only on `/mcp` (any other route is `403 token_scope`): a read token is refused on every write tool, and a write token is still refused while the host has writes off. A third scope, `mcp:irreversible`, is needed for a delete that cannot be undone, judged per call by `src/agent/security/irreversible.ts` (`download_delete` with `deleteFiles: true`, `navidrome_playlist_delete`, a service API `DELETE` or delete-style flag, a provider tool with `destructiveHint`): `mcp:write` is refused it with `mcp_irreversible_required`. The refusal is immediate and names the scope to grant; nothing waits. The check is the same gate, in `invokeMcpTool`, fed by the route's `{ writes, irreversible }`. A token without a scope, the shared token and `THEBE_TOKEN` keep full access, and a stored scope Core does not know is refused. Every `/mcp` call writes one audit row (`source: "mcp"`, `identity` = the token's name, `result` ok/error/denied; `GET /v1/audit?identity=`). `THEBE_MCP_PORT` opens a second listener that serves `/mcp`, protected-resource metadata, and the optional OAuth protocol endpoints (`mcp-only.ts`) so the internet-facing port never reaches `/v1`, `/openapi.json`, or `/docs`. A scoped token is limited to `THEBE_MCP_RATE_LIMIT` calls a minute (default 120, `rate-limit.ts`), refused with `429` at once. A Core-side approval queue is on the ROADMAP, not built.
_Avoid_: MCP elicitation as an approval gate (Core cannot tell whether a person answered), a pending-write queue before someone needs one, treating `/mcp` as read-only

**OAuth gateway**:
The optional MCP authorization server in `src/delivery/http/oauth/`, enabled only by a stable `THEBE_OAUTH_ISSUER`. Pre-registered clients use Authorization Code + PKCE; Dynamic Client Registration is off unless explicitly enabled. `/mcp` is the only allowed resource, advertised by RFC 9728 metadata and the `401` Bearer challenge. Access tokens are audience-bound PS256 JWTs valid for 15 minutes and are checked against persisted JTI records, so refresh-token/grant revocation takes effect on the next request. `offline_access` plus `prompt=consent` issues a rotating refresh token and a 30-day grant. The authorization page requires a one-time pairing code from `POST /v1/oauth/pairing-code` (full-access token only) and lets the person narrow requested scopes. `GET /v1/oauth/connections` lists connector grants, and `DELETE /v1/oauth/connections/{grantId}` revokes the grant with its access tokens, refresh tokens, and unredeemed authorization codes; both routes require the full-access token and stay on the App/API listener. The TUI can list and revoke the same local grants with `/connections`; `GET /v1/health` advertises `mcp-oauth` when configured. Signing keys, provider state, and pairing hashes stay under the config directory.
_Avoid_: accepting an unregistered resource, treating a valid signature as authorization after its grant is revoked, exposing the pairing API on the gateway port, or changing the issuer against existing key state

**Push outbox**:
The durable queue push notices go through (`push-outbox.json` beside the device state). One ordered queue exists per Ticket per device, each notice carries a sequence number and an idempotency key (`id`) shared with the Push Relay, and both ordering fields are signed with the event. The head is retried with back-off from 5 s to 300 s while the relay is unreachable, without limit; three transient relay or APNs errors drop it, a permanent refusal drops it at once, and each drop is recorded with its reason. Delivered ids, pending queues and sequence counters survive a Core restart. With push enabled, `GET /v1/health` reports the outbox under `push`.
_Avoid_: best-effort push, a fire-and-forget send, giving up on a notice because the relay was down

**Goal Watchdog**:
The deterministic inactivity supervisor in `src/agent/watchdog/`. It scans every 60 seconds. A Goal with no semantic progress gets one read-only status check after 30 minutes and pauses into `person / stalled` at 60; an inactive worker or reviewer is cancelled and retried once after 10 minutes, then pauses after another 10. Interventions are bounded, audited as `watchdog.*`, retained on `GoalRun.watchdog`, and never grant authority or change a Mandate.
_Avoid_: treating audit traffic as progress, asking the active worker to diagnose itself, or retrying without a bound

**Release line**:
Day-to-day work is on `dev`; `main` is the default branch and holds the tagged releases. A `v*` tag on `main` runs `publish-image`, which builds amd64 and arm64 and pushes `ghcr.io/unitsung/thebe-core`. `docker/metadata-action` drops the `v`: tag `v0.1.0` gives `0.1.0`, `0.1`, `0`, `latest` and `sha-<short>`. While the major version is 0, `:0` and `:0.1` float over releases that may break, so pin the full version (`:0.1.0`) in a deployment. A published package version is one index plus its platform images and attestations, so removing old builds means deleting all of that build's versions, never only the tagged one. Pre-1.0, minor versions may change the API.
_Avoid_: pulling `:latest` or `:0` in production, a `v` prefix on image tags, tagging a commit that is not on `main`
