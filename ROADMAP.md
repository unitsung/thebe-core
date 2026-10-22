# Thebe Core — Roadmap

> 中文速览：这是 Core 的路线图。已交付见 **Shipped**；内测前待办见 **Next**；内测后见
> **Later**；已识别但未排期的方向见 **Candidate directions**，其中包含**目前没有的 web 界面**；
> 明确不做见 **Not planned**。Core 目前是 API-first：用终端、HTTP API 或 MCP 使用；除了 `/docs`
> 的 API 参考页（Swagger UI），没有任何 web 界面。

Status: living document. It reflects what `dev` contains and the remaining work named in
`docs/CORE-PRODUCT-HTTP.md`. It is a plan, not a commitment, and nothing here is scheduled to a
date. There is no tagged release yet.

Core is used from the terminal, over the HTTP API, or through MCP. The only page it serves is
the API reference at `/docs` (Swagger UI); it is not a client. Graphical clients are separate
projects that use the same `/v1` API.

## Scope

Core is a homelab tool server with approvals and an audit log, plus an agent for the terminal.
It is not a general agent platform or a chat gateway. That shapes the plan:

- Reach other agents through `/mcp` rather than replacing them. Write tools on `/mcp` are the
  main gap (see "Later").
- The built-in agent loop stays for background work, the terminal, and people who have no other
  agent. Do not grow it into a second Claude Code or Codex.
- Keep `/v1` and `/mcp` stable; clients built on them should not need Core-specific changes.

## Shipped (on `dev`)

**Runtime and delivery**

- The reasoning loop is `pi-coding-agent`, reached through the `AgentRuntime`
  interface; Core ships no second loop.
- Delivery surfaces: terminal TUI (`node dist/tui.js`), a one-shot CLI, the HTTP
  `/v1` API, and an MCP endpoint `/mcp`.

**Conversations and durable work**

- Sessions (create, resume, fork, compact, export, steer, follow-up, model
  selection, revert), prompts, Goals, Workers/subagents, schedules, and
  normalized events.
- Product HTTP: capability runs, Activity feed, Goals, Workers, pending
  permissions, Skills, MCP lifecycle, enabled resources, permission mode, Agent
  settings, Artifacts, audit, push device registration, and provider OAuth
  renewal, each with OpenAPI schemas.

**Capabilities and integrations**

- Arcane (containers), Emby/Jellyfin (media search), Immich (photos), Navidrome
  (music), OpenList (files and offline download), and qBittorrent (downloads).
- Containers without a panel: the Docker Engine API through a restricted
  `docker-socket-proxy` (`THEBE_DOCKER_PROXY_URL`), with Arcane taking
  priority when configured and the approved `container.restart` path unchanged.
- Prowlarr release search, used inside the acquisition pipeline
  (`adapters/pipeline/prowlarr-search.ts`) rather than as a standalone adapter.
- Two acquisition-job kinds on one durable state machine
  (`agent/pipeline/job-runner.ts`): `torrent` (download → place → scan → verify)
  and `cloud_transfer`, which fetches a share/direct link through a
  `CloudTransferProvider` (OpenList offline download) before the same
  place → scan → verify steps. An Agent-owned background advancer
  (`agent/pipeline/advancer.ts`) keeps jobs
  acquired in the running process moving without a client, so a network-drive
  import finishes while the phone sleeps; a job restored after a Core restart
  still needs an explicit `pipeline.advance`.
- Generic HTTP services defined by an OpenAPI 3 / Swagger 2 document, through
  `service_api_discover` / `service_api_read` / `service_api_write`.
- Session web search and `music_research`.
- Skills (from `.thebe/skills/`) and external MCP servers (from `.thebe/mcp.json`,
  plus the global config and `.mcp.json`).

**Safety**

- Permission modes (`plan` / `manual` / `acceptEdits` / `bypassPermissions`),
  `CommandRisk` grading, workspace
  confinement, Docker command and API guards, host bash isolation via
  `@anthropic-ai/sandbox-runtime` (`THEBE_SANDBOX=off` is the only escape hatch;
  a container leaves it unset), output redaction
  before the model and before disk, and an append-only audit log (on by default, `audit.jsonl` in the agent store).
- `bypassPermissions` is session-scoped and always selectable. The TUI and
  graphical clients ask before turning it on. `THEBE_FULL_ACCESS` is ignored.
  `PUT /v1/session/{id}/permissions` sets it for one conversation, and it is
  never inherited by subagents, schedules, background goals, `/mcp`, or
  non-interactive turns.

**Product contract**

- Diagnosis `POST /v1/diagnosis` and `ActionReceipt` (slice 02: `container.restart`).
- Durable Artifacts (`diagnosis`, `report`, `resource_list`, `operation_receipt`,
  `task_output`), capability-run / Goal / Worker recovery, and the Activity read
  model with cursor and source/status/time filters.

**Deployment**

- One container, backup / restore / upgrade on `/data`, host TLS paths
  (Tailscale or a reverse proxy), `scripts/smoke.mjs`, `scripts/release-check.sh`,
  and CI.

## Next

Work named for the first beta, not yet complete in this checkout.

- **Real-provider and deployment acceptance.** OpenList, Arcane, qBittorrent and
  the other providers are wired but not verified against live instances. The
  container image is now built and pushed to GHCR (linux/amd64 + arm64) by
  `.github/workflows/publish-image.yml`; its first green run and a live
  `scripts/smoke.mjs` against a real deployment are still pending.

## Later

Named after the first beta.

- **More service coverage through provider MCP.** Radarr, Sonarr, Lidarr,
  Prowlarr, Jellyseerr, Plex, Proxmox, and TrueNAS are reached through each
  service's own MCP server (`.thebe/mcp.json`, with `headers` for token auth),
  not as new built-in `vendor.tool` modules; Core adds a built-in adapter only
  where it owns the semantics (the approval → execute → verify → receipt action
  path, as with containers and diagnosis).
- **Write tools for external agents on `/mcp`.** Today every write is refused over
  `/mcp`, so another agent can look but not act. Offer the approval-gated writes
  there with approval over MCP elicitation, or an out-of-band approval a client
  confirms (the pending-permission queue and `ActionReceipt` already exist), and
  scope tokens first, because a token has full access today. Add a light way to
  start Core for this use (`npx` or stdio) so a workstation user need not run the
  container. Verify against real clients (Claude Code, Codex, Hermes) before
  claiming compatibility.
- **Third-party harnesses behind the same seam (low priority).** Claude Code (Claude Agent SDK, in
  process) and Codex (`codex app-server`, JSON-RPC) as additional `AgentRuntime`
  implementations next to Pi, chosen per session, so any `/v1` client keeps
  one protocol while approvals, the command guard and audit stay in Core. Built-in
  shell and edit tools of those harnesses stay off unless routed through Core's guard.
  Needs a runtime registry (today `bootstrap` wires one runtime), an explicit
  "not supported" marking for Pi-only session operations (fork, revert, steer,
  compact), and approval over MCP elicitation so write tools can also be offered to
  external agents on `/mcp`. Check each vendor's current terms before offering
  subscription sign-in. Revisit only if users ask to chat through their own
  Claude or Codex subscription; the `/mcp` item above covers most needs first.
- **Remote push.** APNs delivery through an optional, separately deployed Thebe
  Push Relay that Core signs minimal events for; a self-hosted Core never embeds
  Thebe's APNs credentials.
- **Open-source release prep.** Done in the tree: README set, security policy,
  contributing guide with a DCO sign-off check, a trademark note, internal audit and
  research notes moved out, and a scan of tracked files and history for credentials
  (none found). Decided: the existing history is published as it is. Still open: create the
  public default branch, turn on private vulnerability reporting, tag `v0.1.0`, make the GHCR
  package public, and run a live acceptance against real providers.
- **Sandbox follow-ups.** A host network allowlist, if one is needed, stays inside
  `@anthropic-ai/sandbox-runtime`. The release container does not nest it.

## Candidate directions (identified, not scheduled)

- **Web client / browser surface.** Core ships no web UI and none is planned. Without a
  graphical client, a user has the terminal, the raw API (with `/docs`) or MCP. `CONTEXT.md`
  (TUI) explicitly rejects a Thebe-written web chat. Peers such as Open WebUI, Home Assistant
  Assist and Hermes do offer a browser surface. This is an open question, not a decision;
  revisit after the first release, with no hard metric. Any such client must go through the same
  `/v1` seam and safety boundary (token, Host allowlist, origin/CSRF for browser writes, no
  arbitrary host paths, no credential exposure) and must not become a second agent loop.
- **New provider-native background-task producers.** OpenList, Arcane, and
  qBittorrent are already on the Activity source seam; another provider extends
  the same feed rather than adding a new lifecycle owner.

## Not planned

Explicit non-ships from `CONTEXT.md` and `docs/CORE-PRODUCT-HTTP.md`, kept here so
they are not re-raised as omissions:

- A Goal identity rewrite or `GET /v1/goals/{id}/runs`.
- Replacing raw `/mcp` for integrations.
- Skill file or arbitrary extension code editing.
- Arbitrary filesystem browsing, uploads, or unrestricted Artifact paths.
- A chat-tool `/v1/approvals` collection (diagnose-restart uses `/v1/activity`;
  tool confirmations use `/v1/permissions`).
- A second agent loop, or a Thebe-owned transcript store.
- iOS DTOs, SwiftUI screens, or native provider clients inside Core.
- Self-hosted inference; Octop / Hermes / ACP as dependencies.
