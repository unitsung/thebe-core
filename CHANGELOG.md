# Changelog

All notable changes to Thebe Core are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

There is no tagged release yet. The entries below are what `dev` currently contains.

## [Unreleased]

### Changed

- The command guard reads a command as shell before its text rules apply. `rm -r -f /`, `r''m -rf /`, `rm -rf "$HOME"`, `cd / && rm -rf *`, `sh -c '…'`, `eval`, `find / -delete` and `chmod -R` on the root are blocked; `curl … | sh`, a run-time-built shell command, a command name known only at run time and reads of SSH or cloud credentials ask first. The parser loads at startup; without it the text rules decide alone.
- Permission modes are read by their four names only. The old `ask`, `read-only`, `full-access` and `default` spellings are no longer accepted: a `config.json` that still holds one falls back to `manual`, and an API call with one gets `400`. `POST /v1/session/{id}/full-access` still switches `bypassPermissions`.
- Research budget per answer raised to 8 `web_search` and 6 `music_research` lookups (12 combined, was 3, 2 and 4) so a search for a song or a release can try several queries; the same query is still never run twice.
- The system prompt now says `tool_search` matches English words only, because its ranker drops non-ASCII text and a Chinese query found nothing. This changes the prompt once; it is the same text on every later call.
- `THEBE_SANDBOX` accepts `auto`. A sandbox that was asked for and is not available now refuses the command instead of running it unsandboxed.

### Removed

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
  lifts the command guard, the OS sandbox, and tool approval for one session; it
  needs `THEBE_FULL_ACCESS=on` on the host and is not inherited by subagents,
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
