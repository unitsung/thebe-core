# Migration note: AgentHarness adapter → Pi coding-agent runtime

## Removed

| Removed | Replacement |
|---|---|
| `src/agent-adapter` (`createAgentAdapter`, `AgentHarness`, `thebeConvertToLlm`) | `src/runtime/pi/pi-coding-agent-runtime.ts` via `createAgentSession` |
| `src/run-store` (Thebe transcript snapshots, token ledger files) | Pi session manager; ProductStore for mapping metadata only |
| `src/session-export` (`exportRunJsonl` / `exportRunHtml`) | Pi `exportSessionToJsonl` / `exportSessionToHtml` inside the Pi wrapper |
| Direct `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` product dependencies | `pi-coding-agent` owns those packages. `pi-ai` remains a **devDependency** only for Pi wrapper tests (`fauxProvider`) |
| Pi-hook policy wiring on `before_tool` / `after_tool` / `transform_context` | Product-layer wrap of custom tools (`src/product/wrap-tools.ts`) |
| ADRs `0001-build-on-pi`, `0002-node-pnpm-vite-vitest`, `0003-v0.3-slice` | `docs/architecture.md` and `docs/adr/0001-pi-coding-agent-runtime.md` |

## Kept

ArcaneAdapter, ContainerInfoProvider, `container.*` tools, redaction, AuditLog, PolicyEngine (custom tools only), StreamGuard (normalized events), HTTP `/v1/*` and `/mcp`, TUI.

`@earendil-works/pi-server@0.85.0` is a runtime dependency because Pi 0.85.0's extension loader statically imports the coding-agent package entry, which loads experimental server types. Thebe does not call that server.

## Tests

From `core/`:

```
pnpm test
pnpm typecheck
```
