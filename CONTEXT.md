# Thebe Core

The homelab Agent. A replaceable coding-agent runtime owns the loop; this repo does not write one. v0 is four read-only container tools through Arcane plus Pi built-in coding tools.

## Language

**Thebe Core**:
This repository and the Agent it is. Package and repo name are `thebe-core`.
_Avoid_: thebe-agent-core, Thebe Agent Core, core_v0, a dashboard proxy with no Agent

**AgentRuntime**:
Thebe-owned replaceable runtime boundary. Product, HTTP, TUI, and iOS-facing code import only this, `RuntimeSession`, and normalized events.
_Avoid_: AgentAdapter, raw `Agent`/`AgentHarness`, Pi session objects in product code

**PiCodingAgentRuntime**:
First `AgentRuntime` implementation. Embeds `@earendil-works/pi-coding-agent` via `createAgentSession`. Must not spawn the Pi CLI.
_Avoid_: depending on Pi types outside `src/runtime/pi`, wrapping the Pi CLI

**RuntimeSession**:
One runtime-backed conversation. Create, resume, list, fork (including at a message), compact, export, steer, follow-up, model selection, and revert are runtime facilities.
_Avoid_: Thebe-owned transcripts, branch stores, or local HTML/JSONL exporters

**NormalizedEvent**:
The only event shape clients see (`text_delta`, `tool_start`, `tool_end`, `session_end`, `interrupted`, `queue_update`, `permission_requested`, …).
_Avoid_: Pi `AgentSessionEvent`, `assistantMessageEvent`, harness hook payloads

**ProductStore**:
Thebe persistence for product metadata only: `thebeSessionId`, `runtimeId`, `runtimeSessionId`, title, timestamps, selected context, labels, share metadata, remembered permissions.
_Avoid_: storing transcripts, branch topology, compaction records, or OAuth refresh tokens

**Prompt**:
One user turn through the Thebe product service into a `RuntimeSession` (`ThebeProduct.prompt()`). Modes are `prompt`, `steer`, and `followUp`. `send()` is a compatibility alias.
_Avoid_: naming this Ask, a second agent loop, a parallel Thebe CLI suite

**TUI**:
`@earendil-works/pi-tui` (`TuiMainScreen`, `Editor`, `Markdown`, `Text`). Start with `node dist/tui.js`. Prompt is the agent turn; this package is the terminal.
_Avoid_: a homegrown renderer, a Thebe-written web chat

**Serve**:
Thin HTTP listener. Session API is `/v1/session` (create, prompt, messages, log SSE, interrupt, permission). iOS compatibility: `/v1/health`, `/v1/event(s)`, `/v1/devices`, `/v1/messages` (JSON auto-denies approvals; SSE with `Accept: text/event-stream`), `/mcp`. Default bind `127.0.0.1:8787`; logs print both the local URL and `bind=host:port`. `NODE_ENV=production` requires `THEBE_TOKEN` (`X-Thebe-Token`). `POST /v1/system/quiesce` is admin-equivalent (token is the only gate) and blocks mutating writes except interrupt/permission. Credential PUT/POST is plaintext HTTP; production should sit behind Tailscale or an HTTPS reverse proxy. SIGTERM/SIGINT drain via `product.quiesce()`. HTTP body cap 10MB.
_Avoid_: a second agent loop, MCP servers as a product, pairing/APNs as v0 features

**Tool Layer**:
Thebe custom capability surface. v0 registers `container.list` / `container.inspect` / `container.logs` / `container.status_summary`. Redaction is internal and runs before results enter runtime history.
_Avoid_: a second allow-list in config or flags, treating redaction as its own module

**Pi built-in tools**:
Runtime-owned `ls`, `find`, `grep`, `read`, `edit`, `write`, `bash` enabled on the same session as `container.*`.
_Avoid_: reimplementing filesystem/bash tools in Thebe

**ContainerInfoProvider**:
The only capability declaration for read-only container observation. Tool Layer and PolicyEngine speak only this interface.
_Avoid_: tool code importing a panel SDK or HTTP client

**Arcane**:
The only container panel. Thebe Core does not talk to docker.sock. Only ArcaneAdapter; no Dockge, no multi-panel.
_Avoid_: ADMIN_STATIC_API_KEY, a homegrown Docker manager

**PolicyEngine**:
Interception and budgets for Thebe custom tools. `decide` is a pure function; `beforeToolCall` is fail-closed. Pi built-ins are not PolicyEngine's concern.
_Avoid_: Gate, Harness, Session, Pi-hook-specific policy wiring, stopping a Run with a terminate field

**StreamGuard**:
Per-Run application timeouts over normalized events: TTFB + idle timers plus an abort watchdog.
_Avoid_: treating upstream timeoutMs as the only backstop, wrapping Pi `StreamFn` in product code

**AuditLog**:
Immutable, append-only, Thebe-Core-writable local JSONL. Redaction at two points (before the model and before disk). Routine cannot disable audit.
_Avoid_: a model-writable audit tool, making audit opt-in
