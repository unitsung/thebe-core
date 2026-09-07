# Thebe Core architecture

Thebe is a homelab product on a replaceable coding-agent runtime. It is not an agent framework.

## Layers

| Layer | Owns |
|---|---|
| Product (HTTP, TUI, iOS protocol, audit, Arcane, `container.*`, PolicyEngine, ProductStore) | Session identity mapping, homelab context, redaction, custom tools, client event protocol |
| `AgentRuntime` / `RuntimeSession` / `NormalizedEvent` | Thebe-owned boundary. No Pi types cross this line |
| `PiCodingAgentRuntime` (`src/runtime/pi`) | `@earendil-works/pi-coding-agent` via `createAgentSession`: loop, transcript, fork, compaction, JSONL/HTML export, providers, OAuth, built-in tools |

## Data

ProductStore records only `thebeSessionId`, `runtimeId`, `runtimeSessionId`, title, timestamps, selected context, labels, share metadata, and remembered permissions. Transcript, branches, compaction, and OAuth refresh tokens stay in the runtime.

## Entry points

`createThebeApp` is the shared factory. HTTP `/v1/session`, `/v1/messages`, `/mcp`, and the TUI all go through the same product service, custom-tool wrap, and session mapping.

Historical migration specs live in `docs/spec-history/` and are not the active spec.

## Skills and extensions

Nothing is auto-loaded from disk. Thebe passes an explicit resource loader and records identity, version, and source in audit when a skill or extension is enabled.
