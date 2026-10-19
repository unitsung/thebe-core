# Thebe Core

The homelab Agent and capability plane. The Pi runtime owns the reasoning loop behind the `AgentRuntime` interface; this repo does not write a second one. Core turns user intent into discoverable homelab capabilities, normalized events, safe operations, and auditable task results. Service-specific behavior belongs in built-in adapters or external plugins/MCP integrations.

## Language

**Thebe Core**:
This repository and the Agent it is. Package and repo name are `thebe-core`.
_Avoid_: thebe-agent-core, Thebe Agent Core, core_v0, a dashboard proxy with no Agent

**AgentRuntime**:
Agent-owned runtime Interface in `src/agent/runtime`. Delivery code imports the Agent Interface; the Pi adapter implements this boundary. It is a structural seam, not a claim that a second runtime is integrated.
_Avoid_: a top-level runtime grab bag, AgentAdapter, raw `Agent`/`AgentHarness`, Pi session objects in Agent or delivery code

**CommandRisk**:
Homelab/NAS command heuristics in `src/agent/security/command-risk.ts`: `assessCommand`/`assessToolCall` grade a tool call `safe`/`caution`/`dangerous`/`critical` (storage systems, NAS volumes, disk writes, container breakouts, workspace escape) and the agent's permission preflight denies `critical`, asks for `dangerous`. Container commands get their own guard (`docker-command-guard.ts`), and Docker Engine API calls issued straight at `docker.sock` (curl/podman) go through `docker-api-guard.ts`. The layer is always on; only `bypassPermissions` lifts it, for one session.
_Avoid_: putting model-based review here (that is `JudgmentModel`), blocking inside the adapter instead of the preflight

**PermissionMode**:
The one setting that decides how much a session may do without asking: `plan` (read-only), `manual` (ask each time), `acceptEdits` (workspace edits and sandboxed commands run unasked), `bypassPermissions` (nothing asked, command guard and sandbox lifted). Names are Claude Code's; the rules for `acceptEdits` follow Codex's on-request policy with a restricted sandbox (`src/agent/security/accept-edits.ts`, ADR 0004). Stored per session as `AgentSessionMeta.permissionMode`, the host default in `config.json`; `bypassPermissions` only where the host sets `THEBE_FULL_ACCESS` and never inherited by subagents, schedules, background goals, `/mcp` callers, or non-interactive turns. Only the four names are read.
_Avoid_: a second permission-mode name, a remote-controlled switch for `bypassPermissions`, command-safety lists (the sandbox is what makes running unasked acceptable)

**GondolinMicroVM**:
Micro-VM execution path in `src/adapters/gondolin`: `runner.ts` maps the workspace to `/workspace` (escaping the jail throws) and owns the VM lifecycle, `bash-operations.ts` makes it the `bash` backend behind `THEBE_SANDBOX=gondolin`. A VM's lifetime is the process, not the session that booted it: every boot registers in `lifecycle.ts`, which `bootstrapThebe().disposeSandboxVms` drains on the way out, so stopping Core cannot leave a hypervisor behind with no owner. The VM provider is injectable, so tests run without QEMU/KVM; `@earendil-works/gondolin` stays an optional dynamic import (clear failure, no silent unsandboxed run).
_Avoid_: importing Pi types outside `src/adapters/pi`, falling back to local execution without telling the caller

**CommandSandbox**:
Optional jail for the `bash` tool in `src/agent/security/command-sandbox.ts`, chosen by one variable, `THEBE_SANDBOX=off|auto|bwrap|docker|seatbelt|gondolin` (`auto` picks what the host can run). bubblewrap: read-only host, ephemeral `/tmp`, workspace-only writes, dropped capabilities. Wrapping happens in the Pi session's bash `spawnHook`; a backend that was asked for and is missing refuses the command (`sandboxedCommand`) rather than running it bare. `THEBE_SANDBOX=gondolin` (same variable) instead routes bash through `src/adapters/gondolin` for hardware-VM isolation.
_Avoid_: forcing the sandbox on by default, sandboxing through the tool layer instead of the spawn hook

**PiCodingAgentRuntime**:
First `AgentRuntime` implementation. Embeds `@earendil-works/pi-coding-agent` via `createAgentSession`. Must not spawn the Pi CLI.
_Avoid_: depending on Pi types outside `src/adapters/pi`, wrapping the Pi CLI

**Pi version pin**:
`@earendil-works/pi-coding-agent`, `pi-server`, `pi-tui` (dependencies) and `pi-ai` (dev) are pinned together (currently `1.0.4`) and listed in `pnpm-workspace.yaml#minimumReleaseAgeExclude`. Pi's dist is loaded by URL from its own `node_modules` (`src/adapters/pi/sdk/load-pi.ts`), including `pi-ai` for providers that need its helpers, so Core never depends on pi-ai directly and never bundles a second copy. Provider streams receive a normalized transcript (`getCurrentSystemPrompt` / `getCurrentTools`), not `context.systemPrompt`/`context.tools`.
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
How a vendor service reaches the model, in preference order: (1) the provider's own MCP server (`.thebe/mcp.json`: `url` + `headers`, or `command` + `env`; also reachable from the App, TUI, and `thebe mcp`); (2) `service_api_discover` / `service_api_read` / `service_api_write` over the service's own OpenAPI 3 / Swagger 2 document — whose operator allow-listed read operations are each also exposed as their own MCP tool (`service_api.<id>.<operationId>`), still with no per-vendor code; (3) a built-in adapter — only with a reason Core owns. Which services actually ship an MCP server today is recorded in `docs/PROVIDER-MCP.md`. Built-in adapters exist today for: containers (`Arcane`, or the Docker Engine proxy via `docker-socket-proxy`) because the write runs on Core's approval → execute → verify → receipt path; the acquisition pipeline (`DownloadProvider` qBittorrent, `CloudTransferProvider`/`FilesProvider` OpenList, Prowlarr release search, Emby/Jellyfin library refresh) because Core owns its durable job state machine, bounded retries, and background advancer rather than a single request/response; and read-only media/photo/music observation (Emby, Jellyfin, Immich, Navidrome) that shipped before this rule. Radarr, Sonarr, Lidarr, Prowlarr's own management, Jellyseerr, Plex, Proxmox, and TrueNAS are reached through a provider MCP server or `service_api_*`, not new `vendor.tool` modules.
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

**TUI**:
`@earendil-works/pi-tui` (`TuiMainScreen`, `Editor`, `Markdown`, `Text`). Start with `node dist/tui.js`. Prompt is the agent turn; this package is the terminal.
_Avoid_: a homegrown renderer, a Thebe-written web chat

**Serve**:
Thin HTTP listener. Session API is `/v1/session` (create, prompt, messages, log SSE, interrupt, permission). Product Goal API is `/v1/goals` (create, list, get, pause/resume/stop, log JSON/SSE) with session-scoped aliases under `/v1/session/{id}/goal`. Capability API is `GET /v1/capabilities` and `POST /v1/capabilities/{id}/invoke` (Agent-mediated; `container.restart` stays on `POST /v1/action`). Worker API is `/v1/subagents`. Runtime pending permissions are `/v1/permissions` (not Activity Approvals). Skills `/v1/skills`, MCP inventory `/v1/extensions/mcp/*`, enabled resources `/v1/resources/enabled`, Artifacts `/v1/artifacts`, permission mode `/v1/settings/permissions`. iOS compatibility: `/v1/health`, `/v1/event(s)`, `/v1/devices`, `/v1/messages` (JSON auto-denies approvals; SSE with `Accept: text/event-stream`), `/mcp`. Default bind `127.0.0.1:8787`; logs print both the local URL and `bind=host:port`. Host allowlist always includes loopback; `THEBE_HOST=0.0.0.0` still requires `THEBE_ALLOWED_HOSTS` for LAN Host headers. `NODE_ENV=production` requires `THEBE_TOKEN` (`X-Thebe-Token`). `POST /v1/system/quiesce` is admin-equivalent (token is the only gate) and blocks mutating writes except interrupt/permission. Credential PUT/POST is plaintext HTTP; production should sit behind Tailscale or an HTTPS reverse proxy. SIGTERM/SIGINT drain via `agent.quiesce()` then `server.close`. HTTP body cap 10MB. Default session idle reap is 30 minutes (`THEBE_SESSION_IDLE_TIMEOUT_MS=0` disables).
_Avoid_: a second agent loop, an MCP marketplace as the product, pairing/APNs as v0 features, or exposing raw plugin internals as the client contract

**Tool Layer**:
Thebe custom capability surface. Built-in v0 capabilities include `container.list` / `container.inspect` / `container.logs` / `container.status_summary`; external integrations can add file, media, download, scheduling, and service-specific capabilities through MCP. Redaction is internal and runs before results enter runtime history.
_Avoid_: a second allow-list in config or flags, treating redaction as its own module, or making the built-in container set the product boundary

**DiagnosisRun**:
Product-facing read-only diagnosis (`POST /v1/diagnosis`). The App sends a typed `ResourceRef`; Core gathers bounded observations from container capabilities, optionally reasons, and returns `resource`, `observations`, `diagnosis`, `recommendations`, `runId`, and `actionId`. Observed facts come from tools/providers only. Write recommendations carry `actionId` but are not executed here. One optional Judgment Site may confirm a write recommendation; diagnosis does not own the Judgment Model.
_Avoid_: exposing raw MCP `tools/call` as the App contract, dumping inspect/logs/agent state to the client, or concatenating display names into prompts

**ActionReceipt**:
Product object for an approved write. Slice 02 is only `container.restart`: on-device approval → deterministic provider restart → programmatic verification (`state==running`, Emby health when applicable) → receipt. Metadata `effect=write`, `risk=disruptive`, `approval=required` lives in `CONTAINER_CAPABILITY_METADATA`. Neither the chat model nor a Judgment Model can approve, execute, or grade verification.
_Avoid_: attaching `container.restart` to the chat tool loop, auto-executing from diagnosis, or letting the App call raw MCP for writes

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
_Avoid_: a second Goal id scheme, `GET /v1/goals/{id}/runs`, exposing Pi/MCP/subagent internals, or treating ActivityRecord as a Goal

**Pi built-in tools**:
Runtime-owned `ls`, `find`, `grep`, `read`, `edit`, `write`, `bash` enabled on the same session as `container.*`.
_Avoid_: reimplementing filesystem/bash tools in Thebe

**ContainerInfoProvider**:
The Agent-owned capability declaration in `src/agent/capabilities/containers.ts` for read-only container observation plus the approved `restartContainer` write. Tool Layer and PolicyEngine speak only this Interface; Arcane implements it as an Adapter, and `DockerEngineAdapter` (`src/adapters/docker/adapter.ts`) implements it against the Docker Engine API through a restricted `docker-socket-proxy` (`THEBE_DOCKER_PROXY_URL`) when Arcane is not configured (ADR 0003).
_Avoid_: tool code importing a panel SDK, a Docker client, or an HTTP client directly

**Arcane**:
The default container capability provider. Thebe Core does not talk to docker.sock; when Arcane is configured it wins over the Docker Engine API proxy fallback. ArcaneAdapter owns the built-in container surface; other service categories should normally arrive through their integration plugin/MCP boundary.
_Avoid_: ADMIN_STATIC_API_KEY, a homegrown Docker manager, or expanding Core into a vendor-by-vendor service implementation

**NavidromeProvider**:
Agent-owned music capability in `src/agent/capabilities/navidrome.ts`. `NavidromeAdapter` implements the Subsonic API boundary, including salt+MD5 authentication, library/search/artist/lyrics reads, playlist writes, and provider-neutral playback queues with stream/artwork URLs. Core exposes these as `navidrome.*` capabilities; the iOS App still owns MPV playback, Now Playing, and remote commands. Playlist writes require the runtime permission flow and are rejected by direct MCP or capability invocation.
_Avoid_: exposing Subsonic credentials to the model, making Core start a mobile playback session, or creating a second player engine

**MediaLibraryProvider**:
Agent-owned Emby and Jellyfin library capability in `src/agent/capabilities/media.ts`. The adapters search and read one item when the composition root supplies the server. Core exposes `emby.search`, `emby.item`, `jellyfin.search`, and `jellyfin.item`. Built-in skills name those tools. The iOS App keeps its own library tools and playback.
_Avoid_: handing the connection to Pi, inventing a rating the server did not return

**PhotoLibraryProvider**:
Agent-owned Immich capability in the same module. `immich.search` is semantic search through `POST /api/search/smart`. Metadata listing stays a separate read. A machine-learning failure stays an error.
_Avoid_: treating semantic search as a filename filter, or hiding an unavailable search as an empty library

**AcquisitionJob**:
Durable media-import state machine in `src/agent/pipeline/job-runner.ts`: `submit` → `download` → `place` → `scan` → `verify` → `done`/`failed`, with bounded retries and persisted snapshots (`pipeline.acquire`/`advance`/`status`). Two kinds share it: `torrent` (qBittorrent `DownloadProvider`) and `cloud_transfer`, which fetches a share/direct link through a `CloudTransferProvider` (OpenList offline download) into the file manager before the same place → scan → verify. Providers own credentials and vendor calls; the model chooses the release and folders once.
_Avoid_: putting vendor endpoints in the state machine, a second job runner per service, or running the transfer only while a client is connected

**PipelineAdvancer**:
Agent-owned background loop in `src/agent/pipeline/advancer.ts` that steps acquisition jobs acquired in the running process so they finish without a client (every minute). It never auto-resumes a job restored after a Core restart (that needs an explicit `pipeline.advance`) and stops while quiesced.
_Avoid_: a second scheduler, auto-retrying a failed job, or replaying a restored write-capable job silently

**PolicyEngine**:
Interception and budgets for Thebe custom tools. `decide` is a pure function; `beforeToolCall` is fail-closed. Pi built-ins are not PolicyEngine's concern.
_Avoid_: Gate, Harness, Session, Pi-hook-specific policy wiring, stopping a Run with a terminate field, replacing PolicyEngine with a Judgment Model

**Judgment Model**:
Agent-owned Interface for typed, calibrated judgments over a supplied state. Any Core caller may `ask` a named Site. It answers Noul, Choice, and Score questions; it does not write prose, code, or explanations. Deterministic observation and PolicyEngine stay first. The chat model may still write narrative.
_Avoid_: Decision Model, Decision Engine, System One, classifier as the Core noun, mixing this with 服务商 / Ask Thebe, using PolicyEngine.decide for these questions, treating this as a diagnosis-only feature

**Judgment Site**:
A named place that may call `judgment.ask`. Every Site has a traditional path. The catalog is inventory; a caller opts in by asking. Diagnosis is one Site among others, not the owner.
_Avoid_: hook, 口子, feature flag as the domain noun, treating PolicyEngine, Approval, execute, or verification as Sites

**Judgment Gate**:
Core opt-in for a Judgment Model and, separately, which Sites may call it. Default off. Off, missing credentials, a Site that is not enabled, or a failed call uses that Site's traditional path. On does not move Approval, execute, or verification onto the model.
_Avoid_: a per-服务商 toggle, forcing every Site on when the adapter is on, silently swapping results without a Site id

**Jev**:
First Judgment Model Adapter (TypeSafe hosted API). Vendor name only.
_Avoid_: Jev as a product object, a chat provider, or a Core glossary synonym for Judgment Model

**StreamGuard**:
Per-Run application timeouts over normalized events: TTFB + idle timers plus an abort watchdog.
_Avoid_: treating upstream timeoutMs as the only backstop, wrapping Pi `StreamFn` in product code

**AuditLog**:
Immutable, append-only, Thebe-Core-writable local JSONL. Redaction at two points (before the model and before disk). Routine cannot disable audit.
_Avoid_: a model-writable audit tool, making audit opt-in
