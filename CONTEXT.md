# Thebe Core

The homelab Agent. Pi owns the loop; this repo does not write one. v0 is four read-only container tools through Arcane.

## Language

**Thebe Core**:
This repository and the Agent it is. Package and repo name are `thebe-core`.
_Avoid_: thebe-agent-core, Thebe Agent Core, core_v0, a dashboard proxy with no Agent

**Pi**:
Earendil Works `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`. Thebe Core is a library on top of them.
_Avoid_: treating Pi as a loop we wrote

**AgentAdapter**:
Wrapper around Pi's `AgentHarness`. Ask calls `prompt()` only; `toolExecution` is required `"sequential"` on the type. convertToLlm, transformContext, StreamGuard, and failure-sentinel detection sit behind it. One active lane per Run.
_Avoid_: raw `agentLoop()`, omitting `toolExecution`, Ask constructing `Agent` itself, depending on pi-coding-agent

**Ask**:
One question, via AgentAdapter `prompt()`. HTTP Serve and the TUI are adapters over the same tools, not a second loop.
_Avoid_: a parallel Thebe CLI suite (status / logs / abort / doctor)

**TUI**:
`@earendil-works/pi-tui` (`TuiMainScreen`, `Editor`, `Markdown`, `Text`). Start with `node dist/tui.js`. Ask is the agent; this package is the terminal.
_Avoid_: a homegrown renderer, a Thebe-written web chat

**Serve**:
Thin HTTP listener the iOS `ThebeCoreClient` already speaks: `/v1/health`, `/v1/events`, `/v1/devices`, `/v1/ask`, `/mcp`. Default port 8787. Auth is optional `X-Thebe-Token`.
_Avoid_: a second agent loop, MCP servers as a product, pairing/APNs as v0 features

**v0**:
First product slice: four read-only container tools, Arcane only. No approval, scheduler, MCP, Beszel, or docker.sock.
_Avoid_: treating the spec version "v0.3" as a build checklist, folding §6.2 / §12 into v0

**Tool Layer**:
The capability surface. v0 registers `container.list` / `container.inspect` / `container.logs` / `container.status_summary`. Redaction is internal to this module, not exported.
_Avoid_: a second allow-list in config or flags, treating redaction as its own module

**ContainerInfoProvider**:
The only capability declaration for read-only container observation. Tool Layer and PolicyEngine speak only this interface.
_Avoid_: tool code importing a panel SDK or HTTP client

**Arcane**:
The only container panel. Thebe Core does not talk to docker.sock. Only ArcaneAdapter; no Dockge, no multi-panel.
_Avoid_: ADMIN_STATIC_API_KEY, a homegrown Docker manager

**PolicyEngine**:
Interception and budgets for the Tool Layer. `decide` is a pure function; `beforeToolCall` is fail-closed; after budget or violation latch, `shouldStopAfterTurn` stops the loop — not `tool_result.terminate`.
_Avoid_: Gate, Harness, Session, stopping a Run with a terminate field

**StreamGuard**:
Per-Run application timeouts: TTFB + idle timers plus an abort watchdog. Wired by AgentAdapter; does not rely on fetch/undici.
_Avoid_: treating upstream timeoutMs as the only backstop

**RunStore**:
Thebe-owned persistence: transcript snapshot, Run status, token ledger. The ledger is not its own module.
_Avoid_: reusing Pi session files, a TokenLedger module

**AuditLog**:
Immutable, append-only, Thebe-Core-writable local JSONL. Redaction at two points (before the model and before disk). Routine cannot disable audit.
_Avoid_: a model-writable audit tool, making audit opt-in
