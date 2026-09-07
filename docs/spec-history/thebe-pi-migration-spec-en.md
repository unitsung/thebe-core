# Thebe Migration to Pi Coding Agent Runtime — Reference Spec (English)

> Obsolete as an active spec. Ownership and decisions now live in `../architecture.md`, `../adr/0001-pi-coding-agent-runtime.md`, and `../migration-note.md`.

> Compiled from `thebe-pi-coding-agent-migration-goal.md` as a long-term reference baseline to prevent scope drift.

## Product Position and Immutable Principles

| Principle | Content |
|---|---|
| Product position | Thebe is a homelab product built on top of a replaceable coding-agent runtime, not an agent framework itself |
| First runtime | `@earendil-works/pi-coding-agent`, must be embedded via its supported SDK; must not shell out to the Pi CLI or become a thin CLI wrapper |
| Isolation principle | No Pi-specific type, session object, event shape, storage detail, or internal hook type may leak into Thebe domain, HTTP, TUI, or iOS-facing code |
| Replaceability | A second runtime (e.g. Claude Code, OpenCode) can be added later without changing domain adapters, custom tools, HTTP handlers, or client-facing event types |

## Architecture Layers and Ownership Boundary

The Thebe product layer contains the HTTP/iOS API, local terminal entry point, user and device identity, homelab context selection, product audit and event stream, incident/report/share metadata, and homelab domain adapters (ContainerInfoProvider, ArcaneAdapter, etc.). Beneath this sits the `AgentRuntime` abstraction, whose first implementation `PiCodingAgentRuntime` wraps the Pi SDK's session management, native persistence, branching and compaction, JSONL/HTML export, provider catalogue and OAuth, built-in coding tools, and Pi event model.

### Ownership Table

| Concern | Owner |
|---|---|
| Agent loop, tool-call loop, tool-result loop | Pi Coding Agent |
| Generic session transcript, branch/leaf graph, compaction history | Pi Coding Agent |
| Generic JSONL/HTML session export | Pi Coding Agent |
| Provider catalogue, provider selection, API-key and OAuth lifecycle | Pi Coding Agent |
| Built-in `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` tools | Pi Coding Agent |
| Thebe session identity to Pi runtime session mapping | Thebe |
| HTTP/iOS API, local Thebe entry point, client event protocol | Thebe |
| Homelab semantics, selected host/environment/service context | Thebe |
| Arcane API integration, Arcane pagination and WebSocket logs | Thebe |
| Thebe custom homelab tools such as `container.*` | Thebe |
| Thebe-facing audit correlation, product metadata, reports and shares | Thebe |
| Redaction of custom-tool output before it reaches Pi/UI/export | Thebe |

## Seven Required Implementation Items

1. **Runtime boundary**: Replace the old `AgentAdapter` with `AgentRuntime`/`RuntimeSession`/normalized event interfaces. Thebe code imports only its own interfaces; clients receive only normalized `RuntimeEvent` values.
2. **Implement PiCodingAgentRuntime**: Build around `createAgentSession(...)` to create, resume, list, fork, compact, and export sessions using Pi's native provider/credential system, mapping Pi lifecycle/tool/model/session events into Thebe-normalized events, while preserving Pi's supported cancel/abort semantics.
3. **Mixed tool surface**: A single session enables both Pi built-in tools (ls/find/grep/read/edit/write/bash) and Thebe custom `container.*` tools; ContainerInfoProvider, ArcaneAdapter and their contract tests must not be deleted; web search, if needed, must be an explicitly registered custom tool or trusted extension — no marketplace or auto-discovery.
4. **Remove duplicate ownership**: Delete Thebe's own transcript, branch/fork persistence, compaction implementation, local export implementation, the `convertToLlm` patch, and Pi-hook-specific policy wiring; retain only runtime-agnostic product code (session mapping, identity metadata, audit, redaction, homelab adapters).
5. **Rework persistence**: ProductStore holds only Thebe-owned metadata (`thebeSessionId`, `runtimeId`, `runtimeSessionId`, selected context, labels, share metadata); it must never store Pi transcript, branch topology, compaction records, or OAuth refresh tokens.
6. **Preserve existing entry points**: HTTP, future iOS API, local terminal/TUI, and the optionally retained `/mcp` surface must all route through the same Thebe service layer and runtime/session mapping; no entry point may bypass custom-tool registration, redaction, or identity mapping.
7. **Deliberate handling of skills/prompts/extensions**: Thebe explicitly controls which directories/sources are visible to the Pi runtime; nothing is auto-loaded merely because it exists on disk; the identity/version/source of every enabled extension or skill is recorded in audit metadata.

## Migration Order (must be executed in sequence, no skipping)

1. Add the Thebe-owned `AgentRuntime`/`RuntimeSession`/normalized event interfaces.
2. Implement `PiCodingAgentRuntime` beside the existing direct Harness implementation without deleting old code yet.
3. Migrate one end-to-end path: HTTP Ask → Thebe service → Pi runtime session → streamed normalized events → audit bridge.
4. Add Pi built-in filesystem/bash tools and existing `container.*` tools to the same session.
5. Migrate TUI to the same service/runtime path.
6. Migrate session list/resume/fork/export to Pi-native facilities.
7. Migrate API-key provider selection and one OAuth provider flow to Pi-native facilities.
8. Delete duplicate old implementations only after all acceptance criteria pass.
9. Delete obsolete active spec documents; replace with one architecture document and one ADR.

## Acceptance Criteria (27 items in 7 groups)

| Group | Core Verification |
|---|---|
| A. Runtime boundary (1–4) | Zero Pi type imports outside the Pi implementation; a fake runtime can replace the real one and still exercise the full test suite |
| B. Pi-native session capability (5–9) | Sessions survive a process restart, support list/resume, fork does not mutate the parent, compaction allows continuation, JSONL/HTML export content is correct |
| C. Provider and credentials (10–13) | One API-key provider and one OAuth provider both work via Pi-native flow; Thebe has no self-built OAuth refresh logic |
| D. Mixed tool surface (14–17) | Pi built-in tools and Thebe custom tools coexist in one conversation; Arcane tests are not weakened; redaction works for success/fail/cancel/deny events, proven by a canary secret test |
| E. Product layer and audit (18–21) | HTTP and TUI share the same service and mapping; ProductStore has no duplicated Pi data; audit records are traceable without duplicating full session contents |
| F. Migration cleanup (22–26) | No production code outside `PiCodingAgentRuntime` constructs a bare `Agent`/`AgentHarness`; old implementations are actually deleted, not left as dead code; `package.json` pins the Pi version with lockfile committed |
| G. End-to-end proof (27) | One automated test plus one manual run covering: create session → inspect with built-in tools → query container with custom tool → edit file → run bash → fork → trigger compaction → export both formats → restart and resume → verify canary secret never leaks |

## Explicit Stop Condition and Out-of-Scope Items

Coding must stop immediately once all 27 acceptance criteria are green — this is the document's explicit stop condition. The following are explicitly excluded from this migration and must not be added opportunistically:

- A second runtime implementation (Claude Code, OpenCode, DeepSeek Harness, etc.)
- A runtime marketplace or third-party extension installer, automatic remote package download
- Full iOS UI implementation
- A new authorization/approval product
- Unrestricted autonomous scheduled remediation
- Multi-runtime session migration/import
- A generic workflow engine
- Rewriting Arcane or adding Portainer/Dockge adapters
- Expanding every possible homelab integration

These are separate goals to be pursued only after this migration is reviewed and accepted.

## Final Deliverables (Completion Markers)

Before declaring the migration complete, produce: `docs/architecture.md` describing the new ownership boundary, one ADR recording the decision, a concise migration note listing removed/retired modules and their replacements, a test command or CI workflow executing the acceptance suite, and one manual verification record for the end-to-end proof in Criterion 27.

## Appendix: Issues Identified Before Finalizing (need clarification)

- The directory boundary for "private implementation files" is undefined, making it easy to accidentally break isolation via adjacent files re-exporting types.
- Criterion 8 requires triggering a near-context-limit scenario for compaction, but no method for reliably inducing context pressure in test environments is specified.
- No transition-period compatibility strategy is defined for how Thebe's existing OAuth storage coexists with the new Pi-native OAuth flow during migration.
- Retention of the `/mcp` surface is conditional ("if it remains a deliberate product interface") and needs an explicit go/no-go decision before migration starts.
- Redaction must occur before output reaches Pi session history, but the `RuntimeSession.prompt` interface does not explicitly define where this interception point sits.
- No rollback procedure is defined for the case where deleting old implementations causes a regression against a previously passing acceptance criterion.
