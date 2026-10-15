# Thebe Core — Roadmap

> 中文速览：这是 Core 的路线图。已交付见 **Shipped**；内测前待办见 **Next**；内测后见
> **Later**；已识别但未排期的方向见 **Candidate directions**——其中包含**目前完全没有的
> web 端**；明确不做见 **Not planned**。Core 目前是 API-first：客户端是闭源 Apple App，
> 加上终端 / HTTP / MCP，没有任何 web 页面。

Status: living document. It reflects what `dev` contains and the remaining work
named in `docs/CORE-NEXT-PRODUCT-SPEC.md`, `docs/CORE-PRODUCT-HTTP.md`, and the
App-side `../ui/docs/DEVELOPMENT-PLAN.md`. It is a plan, not a commitment, and
nothing here is scheduled to a date. There is no tagged release yet.

Clients: the closed-source Thebe app for iOS/iPadOS is the only graphical client,
and its source is not published. Anyone using this open-source Core has the
terminal, the HTTP API, and MCP, and no other UI.

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
  `docker-socket-proxy` (`THEBE_DOCKER_PROXY_URL`, ADR 0003), with Arcane taking
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

- Permission modes (`plan` / `manual` / `acceptEdits` / `bypassPermissions`,
  `docs/adr/0004-permission-model.md`), `CommandRisk` grading, workspace
  confinement, Docker command and API guards, one `THEBE_SANDBOX` switch over
  `bwrap` / docker / seatbelt / Gondolin micro-VM backends, output redaction
  before the model and before disk, and an append-only audit log.
- `bypassPermissions` is host-gated and session-scoped: `THEBE_FULL_ACCESS`
  allows it, `PUT /v1/session/{id}/permissions` sets it for one conversation, and
  it is never inherited by subagents, schedules, background goals, `/mcp`, or
  non-interactive turns.

**Product contract**

- Diagnosis `POST /v1/diagnosis` and `ActionReceipt` (slice 02: `container.restart`).
- Durable Artifacts (`diagnosis`, `report`, `resource_list`, `operation_receipt`,
  `task_output`), capability-run / Goal / Worker recovery, and the Activity read
  model with cursor and source/status/time filters.
- Opt-in Judgment Model behind a Judgment Gate (ADR 0001); first adapter Jev.

**Deployment**

- One container (ADR 0002), backup / restore / upgrade on `/data`, host TLS paths
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

Named after the first beta in `../ui/docs/DEVELOPMENT-PLAN.md` and Core's own
research.

- **More service coverage through provider MCP.** Radarr, Sonarr, Lidarr,
  Prowlarr, Jellyseerr, Plex, Proxmox, and TrueNAS are reached through each
  service's own MCP server (`.thebe/mcp.json`, with `headers` for token auth),
  not as new built-in `vendor.tool` modules; Core adds a built-in adapter only
  where it owns the semantics (the approval → execute → verify → receipt action
  path, as with containers and diagnosis).
- **Remote push.** APNs delivery through an optional, separately deployed Thebe
  Push Relay that Core signs minimal events for; a self-hosted Core never embeds
  Thebe's APNs credentials.
- **Open-source release prep.** Scan commit history, remove personal information,
  finish the README set, publish the Docker image, and add maintenance notes.
- **Sandbox evolution.** Harden the staged `bwrap` / Gondolin micro-VM path; see
  `docs/thebe_nas_isolation_and_microvm_research.md`.

## Candidate directions (identified, not scheduled)

- **Web client / browser surface.** Core ships no web UI and none is planned:
  the only graphical client is the closed-source Apple app, which targets
  iOS/iPadOS only. There is no macOS, Windows, Android, or web client (the one
  "Tauri" mention in `security.ts` is a comment example, not a client), so a
  non-Apple device can reach Core only through the raw API or MCP. `CONTEXT.md`
  (TUI) explicitly rejects a Thebe-written web chat. Surveyed peers such as Open
  WebUI, Home Assistant Assist, and Hermes do offer a browser surface. This is an
  open question, not a decision; revisit at the first-beta retrospective, with no
  hard metric. Any such client must go through the same `/v1` seam and safety
  boundary (token, Host allowlist, origin/CSRF for browser writes, no arbitrary
  host paths, no credential exposure) and must not become a second agent loop.
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
