# Changelog

All notable changes to Thebe Core are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

There is no tagged release yet. The entries below are what `dev` currently contains.

## [Unreleased]

### Added

- Terminal UI, one-shot CLI, HTTP API (`/v1`), and an MCP endpoint (`/mcp`).
- Service adapters for Arcane (containers), Emby and Jellyfin (media search), Immich (photos), Navidrome (music), OpenList (files and offline download), and qBittorrent (downloads). With OpenList, qBittorrent, and Emby or Jellyfin configured, an acquisition run can copy, scan, and verify a download. Prowlarr adds release search.
- HTTP services configured with an OpenAPI 3 or Swagger 2 document. Read operations are listed in config; writes ask for confirmation.
- External MCP servers from `.thebe/mcp.json`, and skills.
- Goals, subagents, schedules, and an Activity feed.
- Approvals, risk-graded shell commands, and redaction of tool and MCP output.
- A host-gated, session-scoped full-access preset. `THEBE_FULL_ACCESS=on` allows
  it; `GET /v1/settings/full-access` reports the gate and
  `POST /v1/session/{id}/full-access` toggles one conversation. While active it
  lifts the command guard, the OS sandbox, and tool approval for that session
  only; it is not inherited by subagents, schedules, background goals, `/mcp`
  callers, or non-interactive turns, and audit stays on. See
  `docs/FULL-ACCESS-DESIGN.md`.
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
