# Embed Pi coding-agent as the first AgentRuntime

Thebe needs a real coding-agent loop (tools, sessions, fork, compaction, export, providers) without becoming an agent framework or a Pi CLI wrapper. We embed `@earendil-works/pi-coding-agent` through `createAgentSession` behind Thebe-owned `AgentRuntime` / `RuntimeSession` / `NormalizedEvent` types, and we deleted the previous `AgentHarness` adapter, Thebe transcript store, and local export.

## Considered options

- Keep wrapping `AgentHarness` from `pi-agent-core` (the v0 path). Rejected: duplicates session, export, compaction, and provider work Pi already owns.
- Shell out to the `pi` CLI. Rejected: not an SDK embed; leaks process/CLI coupling.
- Write a Thebe loop. Rejected: product position is homelab-on-a-runtime, not a framework.

A second runtime can be added later without changing HTTP, TUI, Arcane, or client event types.
