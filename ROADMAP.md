# Thebe Core — Roadmap

> 中文速览：这是 Core 的路线图。0.1.0 已交付见 **Shipped**；0.1.0 后已接受的能力见
> **Accepted after 0.1.0**；首个 beta 待办见 **Next**；内测后见 **Later**；已识别但未排期的
> 方向见 **Candidate directions**，其中包含**目前没有的 web 界面**；
> 明确不做见 **Not planned**。Core 目前是 API-first：用终端、HTTP API 或 MCP 使用；除了 `/docs`
> 的 API 参考页（Swagger UI），没有任何 web 界面。

Status: living document. It reflects what `dev` contains (release 0.1.0 and after) and the remaining work named in
`docs/CORE-PRODUCT-HTTP.md`. It is a plan, not a commitment, and nothing here is scheduled to a
date.

Core is used from the terminal, over the HTTP API, or through MCP. The only page it serves is
the API reference at `/docs` (Swagger UI); it is not a client. Graphical clients are separate
projects that use the same `/v1` API.

## Scope

Core is a homelab tool server with approvals and an audit log, plus an agent for the terminal.
It is not a general agent platform or a chat gateway. That shapes the plan:

- Reach other agents through `/mcp` rather than replacing them. Write tools, host gating,
  irreversible checks, audit, and target-scoped tokens are shipped. The calling agent and
  its client ask their user; a Core-side approval queue is not planned.
- The built-in agent loop stays for background work, the terminal, and people who have no other
  agent. Do not grow it into a second general-purpose agent harness.
- Keep `/v1` and `/mcp` stable; clients built on them should not need Core-specific changes.

## Shipped (in 0.1.0)

**Runtime and delivery**

- The default reasoning loop is DeepSeek Harness (DSH), reached through the
  `AgentRuntime` interface. Pi remains available with `THEBE_RUNTIME=pi`.
  Core still ships no second reasoning loop of its own.
- Delivery surfaces: terminal TUI (`node dist/tui.js`), a one-shot CLI, the HTTP
  `/v1` API, and an MCP endpoint `/mcp`.

**Conversations and durable work**

- Sessions, prompts, Goals, Workers/subagents, schedules, and normalized
  events. Pi supports the full create/resume/fork/compact/export/steer/
  follow-up/model-selection/revert surface. The current DSH SDK adapter
  supports create, resume, prompt, steer, follow-up, compaction, model selection
  between launches, export of observed events, and normalized tool/text events.
  DSH-protocol gaps such as fork, revert, and per-tool cancellation fail
  explicitly.
- Product HTTP: capability runs, Activity feed, Goals, Workers, pending
  permissions, Skills, MCP lifecycle, enabled resources, permission mode, Agent
  settings, Artifacts, audit, push device registration, and provider OAuth
  renewal, each with OpenAPI schemas.

**Capabilities and integrations**

- Arcane (containers), Emby/Jellyfin (media search), Immich (photos), Navidrome
  (music), OpenList (files and offline download), and qBittorrent (downloads).
- Containers without a panel: the Docker Engine API through a restricted
  `docker-socket-proxy` (`THEBE_DOCKER_PROXY_URL`), with Arcane taking
  priority when configured and the approved `container_restart` path unchanged.
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
  still needs an explicit `pipeline_advance`.
- Generic HTTP services defined by an OpenAPI 3 / Swagger 2 document, through
  `service_discover` / `service_read` / `service_write`.
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

- Diagnosis `POST /v1/diagnosis` and `ActionReceipt` (slice 02: `container_restart`).
- Durable Artifacts (`diagnosis`, `report`, `resource_list`, `operation_receipt`,
  `task_output`), capability-run / Goal / Worker recovery, and the Activity read
  model with cursor and source/status/time filters.

**Deployment**

- One container, backup / restore / upgrade on `/data`, host TLS paths
  (Tailscale or a reverse proxy), `scripts/smoke.mjs`, `scripts/check-release.sh`,
  and CI.

## Accepted after 0.1.0

- `/mcp` serves the current stateless 2026-07-28 protocol and keeps the
  2025-11-25, 2025-06-18, and 2025-03-26 handshakes (#18).
- Automatic container health (#41), the ticket watchdog (#43), connected OAuth
  client management (#45), and the authorization-model review (#20) were
  accepted on 2026-11-23.
- Real claude.ai and ChatGPT connector acceptance (#46) was confirmed by the
  owner on 2026-11-23; external evidence is not stored in this checkout.
- OpenList MCP instance acceptance was confirmed on 2026-11-23.
- Main Session continuity, long-task delegation, recovery, and Recall are in
  place. Live deployment and external-agent checks are operator steps in
  [DEPLOYMENT.md](docs/DEPLOYMENT.md).
- Two-way IM channels are implemented for Telegram, Weixin, QQ, and iMessage
  through BlueBubbles or local `imsg`. Owner-bound messages reach the
  durable Main Session; queues, cursors, deduplication, reply-window-aware
  notifications, bounded media, QQ recall, and App management are in place.
- Remote push is implemented through the optional Push Relay. The App carries
  the production entitlement, and Core signs events and stores device
  registrations.

## Next

No first-beta feature work remains in this checkout. Operator-only release
checks are documented in [DEPLOYMENT.md](docs/DEPLOYMENT.md); they are not
roadmap tasks.

## Later

Named after the first beta.

- **More service coverage through provider MCP.** Radarr, Sonarr, Lidarr,
  Prowlarr, Jellyseerr, Plex, Proxmox, and TrueNAS are reached through each
  service's own MCP server (`.thebe/mcp.json`, with `headers` for token auth),
  not as new built-in `vendor.tool` modules; Core adds a built-in adapter only
  where it owns the semantics (the approval → execute → verify → receipt action
  path, as with containers and diagnosis).
- **DSH runtime parity.** The DeepSeek Harness SDK is still a developer preview.
  Add the missing fork, revert, per-tool cancellation, historical transcript
  replay, argument-bearing approval requests, per-session runtime selection,
  enabled-resource parity and per-server MCP translation as the upstream
  protocol exposes them. DSH Source/Eval/Ticket orchestration remains unused
  because Core owns that domain.
- **Sandbox boundary alignment.** Pi's host network allowlist and live
  Seatbelt/bubblewrap checks are implemented. DSH currently provides a
  runtime-owned file sandbox but no corresponding network vocabulary, and the
  release container has no egress policy. Align DSH-host network enforcement and
  decide whether the supported deployment needs container egress restrictions.
  The current matrix and verified boundaries are in [docs/SANDBOX.md](docs/SANDBOX.md).

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

- A public Goal API (retired in favor of Tickets), a Goal identity rewrite, or
  `GET /v1/goals/{id}/runs`.
- Replacing raw `/mcp` for integrations.
- Skill file or arbitrary extension code editing.
- Arbitrary filesystem browsing, uploads, or unrestricted Artifact paths.
- A chat-tool `/v1/approvals` collection (diagnose-restart uses `/v1/activity`;
  tool confirmations use `/v1/permissions`).
- A Core-side approval queue for `/mcp` writes. The calling agent and its client ask their user,
  while Core enforces token scopes, the host write switch, irreversible checks and audit.
- A second agent loop, or a Thebe-owned transcript store.
- Client UI code (screens, DTOs) or native provider clients inside Core.
- Self-hosted inference; external agent gateways or Python sidecars as dependencies.
