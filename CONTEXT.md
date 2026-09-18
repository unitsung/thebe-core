# Thebe Core

The homelab Agent and capability plane. A replaceable agent runtime owns the reasoning loop; this repo does not write a second one. Core turns user intent into discoverable homelab capabilities, normalized events, safe operations, and auditable task results. Service-specific behavior belongs in built-in adapters or external plugins/MCP integrations.

## Language

**Thebe Core**:
This repository and the Agent it is. Package and repo name are `thebe-core`.
_Avoid_: thebe-agent-core, Thebe Agent Core, core_v0, a dashboard proxy with no Agent

**AgentRuntime**:
Agent-owned replaceable runtime Interface in `src/agent/runtime`. Delivery code imports the Agent Interface; concrete runtime Adapters implement this boundary.
_Avoid_: a top-level runtime grab bag, AgentAdapter, raw `Agent`/`AgentHarness`, Pi session objects in Agent or delivery code

**PiCodingAgentRuntime**:
First `AgentRuntime` implementation. Embeds `@earendil-works/pi-coding-agent` via `createAgentSession`. Must not spawn the Pi CLI.
_Avoid_: depending on Pi types outside `src/adapters/pi`, wrapping the Pi CLI

**MCP Integration**:
External capability Adapter in `src/adapters/mcp`. It discovers and invokes configured command- or URL-based MCP servers; the Agent owns the stable MCP extension Interface in `src/agent/extensions/mcp`, and HTTP/TUI expose it through `src/delivery`.
_Avoid_: putting Agent runtime, HTTP routes, TUI commands, or homelab business state inside the MCP Adapter; treating server names as the product API

**HomelabCapability**:
User-facing unit of work exposed by an integration, such as file search, media search, download submission, container inspection, service health, or task scheduling. A capability carries a stable name, input/output schema, target service instance, health/error state, and permission level.
_Avoid_: exposing raw vendor endpoints as the only client contract, or requiring the UI to know which MCP server implements a capability

**IntegrationPlugin**:
The service-specific boundary that supplies one or more `HomelabCapability` implementations. A plugin may be a built-in adapter or an external MCP server; it owns credentials, vendor API details, and idempotency while Core owns discovery, policy, task orchestration, normalized events, and audit.
_Avoid_: putting a new agent loop in each plugin, hard-coding every third-party service into Core, or auto-enabling untrusted code

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
Thin HTTP listener. Session API is `/v1/session` (create, prompt, messages, log SSE, interrupt, permission). Product Goal API is `/v1/goals` (create, list, get, pause/resume/stop, log JSON/SSE) with session-scoped aliases under `/v1/session/{id}/goal`. iOS compatibility: `/v1/health`, `/v1/event(s)`, `/v1/devices`, `/v1/messages` (JSON auto-denies approvals; SSE with `Accept: text/event-stream`), `/mcp`. Default bind `127.0.0.1:8787`; logs print both the local URL and `bind=host:port`. Host allowlist always includes loopback; `THEBE_HOST=0.0.0.0` still requires `THEBE_ALLOWED_HOSTS` for LAN Host headers. `NODE_ENV=production` requires `THEBE_TOKEN` (`X-Thebe-Token`). `POST /v1/system/quiesce` is admin-equivalent (token is the only gate) and blocks mutating writes except interrupt/permission. Credential PUT/POST is plaintext HTTP; production should sit behind Tailscale or an HTTPS reverse proxy. SIGTERM/SIGINT drain via `agent.quiesce()` then `server.close`. HTTP body cap 10MB. Default session idle reap is 30 minutes (`THEBE_SESSION_IDLE_TIMEOUT_MS=0` disables).
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

**ActivityRecord**:
Persistence for a pending Approval or a completed Receipt (`GET /v1/activity` returns a typed workspace feed). A diagnosis that recommends restart mints one Approval id; execute mutates that id into a Receipt. Diagnosis without a write recommendation is not stored. `POST /v1/activity/{id}/deny` removes a pending Approval. Stored under the AgentStore directory in an `activity/` subdirectory. `GET /v1/activity` interleaves ProductGoals. Same idempotency key maps to one record. 0 tokens.
_Avoid_: treating this as a full Activity product, naming it the user-facing Activity workspace, dumping raw events, calling the model to summarize the list, or persisting Diagnosis as a sibling row

**ProductGoal**:
Durable objective attached to one parent session. Identity is `thebeSessionId` (`id` === `sessionId`). Product status is `queued` | `running` | `paused` | `succeeded` | `failed` | `cancelled`; runtime `pausing` collapses to `running`. HTTP: `POST`/`GET /v1/goals`, `GET /v1/goals/{id}`, pause/resume/stop, `GET /v1/goals/{id}/log` (JSON or SSE). Session-scoped aliases under `/v1/session/{id}/goal`. Delivery maps through `toProductGoal` / `toProductGoalEvent`.
_Avoid_: a second Goal id scheme, `GET /v1/goals/{id}/runs`, exposing Pi/MCP/subagent internals, or treating ActivityRecord as a Goal

**Pi built-in tools**:
Runtime-owned `ls`, `find`, `grep`, `read`, `edit`, `write`, `bash` enabled on the same session as `container.*`.
_Avoid_: reimplementing filesystem/bash tools in Thebe

**ContainerInfoProvider**:
The Agent-owned capability declaration in `src/agent/capabilities/containers.ts` for read-only container observation. Tool Layer and PolicyEngine speak only this Interface; Arcane implements it as an Adapter.
_Avoid_: tool code importing a panel SDK or HTTP client

**Arcane**:
The default container capability provider. Thebe Core does not talk to docker.sock. ArcaneAdapter owns the built-in container surface; other service categories should normally arrive through their integration plugin/MCP boundary.
_Avoid_: ADMIN_STATIC_API_KEY, a homegrown Docker manager, or expanding Core into a vendor-by-vendor service implementation

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
