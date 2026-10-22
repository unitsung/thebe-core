# Changelog

All notable changes to Thebe Core are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

There is no tagged release yet. The entries below are what `dev` currently contains.

## [Unreleased]

### Added

- aria2 is a second download engine: `THEBE_ARIA2_URL` and `THEBE_ARIA2_SECRET`. `download.add` sends magnets and `.torrent` links to qBittorrent and other links to aria2 (or the `engine` you name); `download.list` merges both, names an engine that did not answer in `unreachable`, and takes an `engine` filter. Every download now carries `engine`, `id`, `phase`, `badges` and `capabilities`, the same vocabulary as the App; the state table is `contracts/download-states.json`, checked in both repositories. An address Prowlarr serves (one its search returned, or any under its base URL) is routed as a torrent although it ends in no `.torrent`; an address shaped like one but served elsewhere is not. `download.pause`, `download.resume` and `download.delete` refuse a download that does not offer that control, a merged `download.list` honours `limit` across engines, and a batch that fails on one engine still runs on the others and says what was already done.
- `sqmusic_search` takes `kind: "album"` and `sqmusic_download` takes `kind: "album"`: one approval queues every song of one album (at most 60) in SQMusic's default quality and reads its tasks back, counting the album's tasks before and after so an earlier queue is not mistaken for this one; an album that does not say how many songs it has is not queued. An artist's catalogue is still never queued.
- HTTP services accept `excludeOperations` and `excludeTags`: matching operations are hidden from discovery and refused on every route.
- Per-device tokens: `thebe token create <name>|list|revoke <name>`. Each is shown once and stored only as a hash in `tokens.json`; last use goes to `token-usage.json`. Revoking one leaves the others working. No scopes: every token has the same access.
- `thebe token status|show|rotate|revoke --all` (`dist/token.js`, `npm run token`) for the shared token. The server reads the token file on every request, so a rotation or revocation applies without a restart; a missing or empty token file refuses every protected request. A `THEBE_TOKEN` environment token is never changed by the command.
- `THEBE_BIND` in `deploy/.env` publishes the container on the host's LAN address for home-network use (docs/DEPLOYMENT.md §4.1); loopback remains the default.

### Fixed

- `service_api_discover` matches every word of a query in any order; "list containers" no longer needs the exact phrase.
- Creating a session with no configured model answers `409 no_model_configured`, and asking for a model that is not available answers `404 model_not_found`; both were an unexplained `500`.

### Changed

- Host bash isolation is pinned `@anthropic-ai/sandbox-runtime` 0.0.80 (Seatbelt / bubblewrap). Unset `THEBE_SANDBOX` means on for a host and off inside a container. The TUI and the App can turn that host sandbox off; the command guard stays on. There is no automatic bypass. `THEBE_SANDBOX=off` still forces it off. `os`, `auto`, `vm`, `gondolin`, `bwrap`, `docker`, `seatbelt` and any other value are ignored, the same as leaving the variable unset.
- Sandboxed bash asks before reaching a host that is not allowed yet, the same shape as Claude Code. Allowing once covers that command. Remembering the host stores it on the Core. Two sandboxed commands at once are not asked, because the connection cannot be attributed. Bypass does not enter the sandbox, so its network stays open.
- `GET /v1/system/isolation` `sandbox.mode` is `off` or `os`. `sandbox.backends` is gone, and `fallback` is always false. A missing dependency refuses commands; `thebe doctor` exits 1.

- The command guard reads a command as shell before its text rules apply. `rm -r -f /`, `r''m -rf /`, `rm -rf "$HOME"`, `cd / && rm -rf *`, `sh -c '…'`, `eval`, `find / -delete` and `chmod -R` on the root are blocked; `curl … | sh`, a run-time-built shell command, a command name known only at run time and reads of SSH or cloud credentials ask first. The parser loads at startup; without it the text rules decide alone.
- Permission modes are read by their four names only. The old `ask`, `read-only`, `full-access` and `default` spellings are no longer accepted: a `config.json` that still holds one falls back to `manual`, and an API call with one gets `400`. `POST /v1/session/{id}/full-access` still switches `bypassPermissions`.
- `bypassPermissions` no longer needs `THEBE_FULL_ACCESS`. The variable is ignored and does not start the process in bypass. The TUI and the App ask before turning it on. A session's own mode is still not inherited by subagents, schedules, background goals, `/mcp`, or non-interactive turns.
- Research budget per answer raised to 8 `web_search` and 6 `music_research` lookups (12 combined, was 3, 2 and 4) so a search for a song or a release can try several queries; the same query is still never run twice.
- The system prompt now says `tool_search` matches English words only, because its ranker drops non-ASCII text and a Chinese query found nothing. This changes the prompt once; it is the same text on every later call.

### Removed

- The Gondolin micro-VM adapter and the handwritten Seatbelt, bubblewrap and disposable-Docker sandbox. `@earendil-works/gondolin` is no longer a dependency.

- Environment variables `THEBE_SCENARIO` (and its four presets), `THEBE_COMMAND_GUARD`, `THEBE_ALLOW_WORKSPACE_ESCAPES`, `THEBE_SANDBOX_NETWORK`, `THEBE_SANDBOX_IMAGE`, `THEBE_SESSION_IDLE_TIMEOUT_MS`, `THEBE_MODEL_RESULT_LIMIT` and `THEBE_PIPELINE_ADVANCE_MS`. The command guard, workspace confinement and Docker API guard are always on; the sandbox keeps the network.
- The `scenario` field of `GET /v1/system/isolation`.

### Added

- Terminal UI, one-shot CLI, HTTP API (`/v1`), and an MCP endpoint (`/mcp`).
- Service adapters for Arcane (containers), Emby and Jellyfin (media search), Immich (photos), Navidrome (music), OpenList (files and offline download), and qBittorrent (downloads). With OpenList, qBittorrent, and Emby or Jellyfin configured, an acquisition run can copy, scan, and verify a download. Prowlarr adds release search.
- HTTP services configured with an OpenAPI 3 or Swagger 2 document. Read operations are listed in config; writes ask for confirmation.
- External MCP servers from `.thebe/mcp.json`, and skills.
- Goals, subagents, schedules, and an Activity feed.
- Approvals, risk-graded shell commands, and redaction of tool and MCP output.
- Permission modes named as Claude Code names them: `plan`, `manual`,
  `acceptEdits`, `bypassPermissions`, set for the host (`PATCH
  /v1/settings/permissions`) and per session (`PUT /v1/session/{id}/permissions`).
  `acceptEdits` lets workspace edits and commands that an enforcing sandbox
  contains run unasked, after Codex's on-request policy. `bypassPermissions`
  lifts the command guard, the OS sandbox, and tool approval for one session. It
  does not need `THEBE_FULL_ACCESS` and is not inherited by subagents,
  schedules, background goals, `/mcp` callers, or non-interactive turns. See
  `docs/adr/0004-permission-model.md`.
- A `cloud_transfer` acquisition-job kind. The durable pipeline state machine
  (`agent/pipeline/job-runner.ts`) now runs either a torrent download or a
  network-drive transfer through a `CloudTransferProvider` seam, wired to
  OpenList's offline download in the composition root, before the same
  place → scan → verify steps. Started through `pipeline.acquire` with
  `kind: "cloud_transfer"`.
- An Agent-owned pipeline advancer (`agent/pipeline/advancer.ts`) that keeps
  jobs acquired in the running process moving without a client, so an import
  finishes while the phone sleeps. `THEBE_PIPELINE_ADVANCE_MS` sets the interval
  (default 60000; `0` disables). Jobs restored after a restart are not
  auto-resumed and failures are not auto-retried.
- Terminal MCP management: `thebe mcp list|tools|add|enable|disable|remove`.
  `add` takes `--url` + repeated `--header K=V`, or `--command` + repeated
  `--arg`/`--env`; a provider's own MCP server is the preferred way to cover a
  vendor service instead of a new built-in adapter. Which services ship one is
  recorded in `docs/PROVIDER-MCP.md`, and `src/adapters/mcp/live.test.ts`
  (`THEBE_MCP_LIVE=1`) connects Core's own client to real servers.
- Per-operation MCP tools from the generic OpenAPI bridge: each read operation
  allow-listed in a configured service's `readOperations` is exposed as
  `service_api.<id>.<operationId>` on `/mcp` and `/v1/capabilities`, with no
  per-service code; writes stay behind `service_api_write` + approval. A spec not
  served by the API host loads via `openapiURL`.
- Less OpenAPI config: `readMethods` trusts chosen HTTP methods and
  `trustReadOnlyAnnotations` trusts the document's own hints (both off by
  default). `writeOperations` exposes chosen writes as a two-phase
  preview → `service_api.confirm` pair, each audited, with a single-use token.
  `scripts/accept-service-api.mjs` checks a service end to end.
- Containers without a container panel: `DockerEngineAdapter`
  (`src/adapters/docker/adapter.ts`) implements the same `ContainerInfoProvider`
  over the Docker Engine API through a restricted `docker-socket-proxy`
  (`THEBE_DOCKER_PROXY_URL`, ADR 0003). Arcane wins when configured; the approved
  `container.restart` path is unchanged; `ResourceRef.provider` gains `docker`.
- A single-container deployment. Build the image from this repository. Durable state stays in `/data`.
