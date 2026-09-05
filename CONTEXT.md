# Thebe Core

The homelab Agent. Pi owns the loop; this repo does not write one. v0 is four read-only container tools through Arcane.

## Language

**Thebe Core**:
This repository and the Agent it is. Package and repo name are `thebe-core`.
_Avoid_: thebe-agent-core, Thebe Agent Core, core_v0, a dashboard proxy with no Agent, a daemon

**Pi**:
Earendil Works `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. Thebe Core is a library on top of them.
_Avoid_: `@earendil-works/pi-coding-agent`, the official `pi` CLI as the product entry, treating Pi as a loop we wrote

**AgentAdapter**:
Wrapper around Pi's `Agent`. Ask calls `prompt()` only; `toolExecution` is required `"sequential"` on the type. convertToLlm, transformContext, StreamGuard, and failure-sentinel detection sit behind it.
_Avoid_: raw `agentLoop()`, omitting `toolExecution`, Ask constructing `Agent` itself

**Ask**:
One question, via AgentAdapter `prompt()`. The product's only entry.
_Avoid_: a parallel Thebe CLI suite (status / logs / abort / doctor)

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
