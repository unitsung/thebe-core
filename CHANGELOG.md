# Changelog

All notable changes to Thebe Core are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Over `/mcp`, `strm.repair` and `sqmusic_download` ran even when the host had set `THEBE_MCP_WRITES=off`, because the write check matched a fixed list of tool names. Core's own tools are now judged by what they declare (the same `effect` that sets their `readOnlyHint`), so any write tool a Core capability adds is held by `THEBE_MCP_WRITES` and by a token's `mcp:write` scope.

### Added

- Tickets, read-only (Phase 2, first slice). `GET /v1/tickets` and `GET /v1/tickets/{id}` list the authorised units of work. A task the person starts through `POST /v1/goals` is recorded as an `explicit`, `direct` Ticket (no Eval weighs it), and the task carries its id as `ticketId` on every Goal response. A Ticket's id is derived from the decision that made it, so a retry of the same request gives the same Ticket; it is kept on disk (`tickets/` in the agent store), bounded, and survives a restart. A Ticket wraps the Goal and does not copy it: status, report and attention stay on the Goal, and the Ticket's stage is not stored. Tickets cannot be created or changed over HTTP (`405`). `GET /v1/health` now lists `capabilities` (`["tickets"]`) so a client knows this Core has them.
- A container-health Source, off by default. `THEBE_SOURCES=container-health` (comma list; `THEBE_SOURCE_INTERVAL_MS`, default 30000, at least 1000) makes Core read container states on a timer and record a Trigger when one changes: `container.went_down` (running to exited, dead or restarting), `container.recovered`, `container.appeared`, `container.removed`, or `container.state_changed`, each on the thread `resource:container:<name>`. The first read only takes a baseline, so a container that is already stopped is not announced; the read position is saved, so a restart does not replay; one failing read never stops the timer. It stops on quiesce. Triggers are only recorded for now (`agent.listTriggers`); nothing reads them yet, and no Ticket is made from one. Docker's own healthcheck is not exposed by the container provider, so "unhealthy" means the state changed, not a failing healthcheck.
- Structured task reports and questions. A Goal's worker now has a `goal_report` tool (states `progress`, `ready`, `blocked`, `ask`, `dropped`) in place of Core reading markers out of its text; the text footer stays as the fallback when a model does not call it, and the independent reviewer still decides `ready`. `blocked` and `dropped` end the checkpoint at once without paying for the reviewer; the report is kept on the Goal (`report`) and survives a restart.
  - `allowAsk: true` (on `POST /v1/goals` and on a schedule) lets the worker ask the person ONE question. The Goal pauses with an `attention` (`kind: "answer"`, `question`, optional `options`); without `allowAsk` a question is turned into a blocker. `POST /v1/goals/{id}/answer` with `{attentionId, answer}` records it, tells every later checkpoint, and continues from the pause; a stale `attentionId` or a second answer is `409` (`attention_stale`, `attention_none`), an empty one `400`, and a plain `resume` while a request is open is `409 attention_open` (`controls.resume` is false). An answer that lands on the last checkpoint gets one more checkpoint so it is not wasted.
  - `reviewBeforeDone: true` (same places) makes a Goal that passed its independent review wait, paused, with `attention.kind: "review"`; `{decision: "accept"}` finishes it, `{decision: "reject", answer: "what to change"}` sends it back and it asks again when done.
  - A paused Goal with an `attention` is `stage: "person"` with `reason` `answer` or `review` in Activity, and unlike failures it never ages out: something is waiting on the person.
  - No new Goal status: a Goal waiting on the person is `paused`, told apart by `attention`.
- `GET /v1/metrics/summary?days=30` (1–365): a read-only summary computed on request from what Core already keeps, for the person who owns it. Goal outcomes in the window (succeeded, failed, blocked, cancelled, running, paused), how many were observe-only and how long the finished ones took (median and 95th percentile), how long approvals waited, and `/mcp` calls by caller with denied and error counts. Nothing is collected or sent anywhere. Token and cost figures are not in it yet: Core does not keep per-session token totals outside a live session.
- `acceptMode: "observe"` on a schedule (`auto` is the default). An occurrence then runs read-only: its worker is the new `goal-observer` profile, which has only `ls`, `find`, `grep` and `read` (no edit, write or shell), so it reports what it found and what it would do and changes nothing; the independent reviewer still checks the report. The mode is enforced by the profile's tools, not by the prompt, and a Goal keeps it (`observe`) across a Core restart. Use it to see whether a new schedule deserves trust before it can act.

### Changed

- A Goal that ended `blocked` keeps `blocked` across a Core restart (it used to come back as an ordinary failure).
- A Goal whose reviewer (or worker) reports `blocked` now stops at that checkpoint instead of spending the rest of its checkpoints on work that cannot go on. It ends as `failed` with `error.code` `goal_blocked` and the blocker (the reviewer's `REMAINING:` line) as `error.message`; clients that do not know the code show it as an ordinary failed task. Its Activity `stage` is `person` with `reason: "blocked"`.

### Added

- (Stage detail) Only things the person asked the assistant to do or must approve count as `person`: a failed Goal, restart receipt or capability run (for 24 hours), a waiting approval, a Goal waiting on an answer or review. A failed background task, or a failed transfer a service reports, is `ended`: it has its own page, and counting it flooded Home on a NAS with many.
- Every `GET /v1/activity` item (and `GET /v1/activity/{id}`) carries a derived `stage`: `person` (it needs you: `reason` is `approval` for a write waiting on your yes, `failed` for something that did not finish in the last 24 hours), `working`, `idle` (a paused task) or `ended`. The stages never overlap and cover every item, and `GET /v1/activity?stage=person` lists exactly the items marked `person`, so a count and the list it opens cannot disagree. Nothing is stored and no existing field changes; a client that ignores `stage` sees the same feed as before (`src/agent/activity/stage.ts`).
- Operator marks for what cannot be undone over `/mcp`: `"irreversible": { "<tool>": true|false }` on a server in `.thebe/mcp.json`, and `irreversibleOperations` / `reversibleOperations` on an HTTP service. A mark beats the server's `destructiveHint` or the HTTP-method rule in both directions; a confirm is judged by the mark its preview carried.

### Changed

- `files.copy` and `files.move` (OpenList) read the destination first and fail at once, naming what is already there, if any of the names exist; nothing is copied or moved. OpenList's own same-name behaviour is not documented for its HTTP API, and a move across storages is an upload then a delete, so Core no longer depends on it. An acquisition job whose destination already holds the same name now stops with that message instead of leaving the outcome to OpenList.

### Added

- A third token scope, `thebe token create <name> --scope mcp:irreversible`, for deletes that cannot be undone. Over `/mcp` these are judged per call: `download.delete` with `deleteFiles: true`, `navidrome.playlist.delete`, a service API call that sends an HTTP `DELETE` or sets a delete-style flag (`deleteFiles`, `purge`, ...), and a provider MCP tool its server marks `destructiveHint`. A `mcp:write` token is now refused these at once with `403 mcp_irreversible_required` and the command that grants the scope; nothing waits. A token without a scope keeps full access, and `THEBE_MCP_WRITES=off` still wins. Existing `mcp:write` tokens lose these calls until recreated with the new scope.
- Gateway hardening for agents that connect over `/mcp`:
  - Every `/mcp` call writes one audit row with the token's name (`identity`), the tool, a hash of the arguments, the result (`ok`, `error`, or `denied` when a scope or the host switch refused it) and the time it took. `GET /v1/audit?identity=<name>` lists one agent's calls.
  - `THEBE_MCP_PORT` (and `THEBE_MCP_HOST`, default `THEBE_HOST`) opens a second listener that serves `/mcp` only; `/v1/*`, `/openapi.json` and `/docs` answer `404` there. Expose that port, not the main one, to the internet.
  - A scoped token is limited to 120 calls a minute over `/mcp`; past that a call fails at once with `429 rate_limited` and `Retry-After`. `THEBE_MCP_RATE_LIMIT` changes the number (`0` turns it off). Tokens without a scope are not limited.
- `Authorization: Bearer <token>` is accepted anywhere `X-Thebe-Token` is, for clients that send a bearer token and cannot set a custom header (Claude's API, most agent frameworks). When a request sends both, `X-Thebe-Token` is the one checked.
- Scoped device tokens: `thebe token create <name> --scope mcp:read|mcp:write` makes a token that works only on `/mcp`. `mcp:read` runs read tools; `mcp:write` also runs write tools, if the host has not turned writes off (`THEBE_MCP_WRITES=off` still wins). A scoped token is refused with `403 token_scope` on every other route, and a write tool refused for want of `mcp:write` answers at once with the command that grants it; nothing waits. A token made without `--scope`, the shared token and `THEBE_TOKEN` keep full access, and a stored scope Core does not know is refused rather than read as full access. `thebe token list` shows each token's scope.

- Optional push through a separately deployed Push Relay (`relay/`). With `THEBE_PUSH_RELAY_URL` set, Core keeps an Ed25519 signing key, publishes the public half at `GET /v1/push/identity`, accepts a `relayDeviceId` on `POST /v1/devices`, and sends a signed, minimal event to the relay when an approval starts waiting. Unset, nothing is sent. Core still holds no APNs credentials.

## [0.1.0] - 2026-10-22

The first release, built from `main`.

### Added

- An agent connected over `/mcp` can call write tools (`container.restart`, the Navidrome playlist writes, a provider MCP server's write tools, and a configured service API's preview and confirm). On by default; `THEBE_MCP_WRITES=off` makes `/mcp` read-only. Core does not ask first on this path; the calling agent and its client ask their user, and every write is audited. A restart's receipt records its approval source as `mcp_client`.
- aria2 is a second download engine: `THEBE_ARIA2_URL` and `THEBE_ARIA2_SECRET`. `download.add` sends magnets and `.torrent` links to qBittorrent and other links to aria2 (or the `engine` you name); `download.list` merges both, names an engine that did not answer in `unreachable`, and takes an `engine` filter. Every download now carries `engine`, `id`, `phase`, `badges` and `capabilities`, the same vocabulary clients use; the state table is `contracts/download-states.json`, checked in both repositories. An address Prowlarr serves (one its search returned, or any under its base URL) is routed as a torrent although it ends in no `.torrent`; an address shaped like one but served elsewhere is not. `download.pause`, `download.resume` and `download.delete` refuse a download that does not offer that control, a merged `download.list` honours `limit` across engines, and a batch that fails on one engine still runs on the others and says what was already done.
- `sqmusic_search` takes `kind: "album"` and `sqmusic_download` takes `kind: "album"`: one approval queues every song of one album (at most 60) in SQMusic's default quality and reads its tasks back, counting the album's tasks before and after so an earlier queue is not mistaken for this one; an album that does not say how many songs it has is not queued. An artist's catalogue is still never queued.
- HTTP services accept `excludeOperations` and `excludeTags`: matching operations are hidden from discovery and refused on every route.
- Per-device tokens: `thebe token create <name>|list|revoke <name>`. Each is shown once and stored only as a hash in `tokens.json`; last use goes to `token-usage.json`. Revoking one leaves the others working. No scopes: every token has the same access.
- `thebe token status|show|rotate|revoke --all` (`dist/token.js`, `npm run token`) for the shared token. The server reads the token file on every request, so a rotation or revocation applies without a restart; a missing or empty token file refuses every protected request. A `THEBE_TOKEN` environment token is never changed by the command.
- `THEBE_BIND` in `deploy/.env` publishes the container on the host's LAN address for home-network use (docs/DEPLOYMENT.md §4.1); loopback remains the default.

### Fixed

- Over `/mcp`, a provider MCP server's write tool ran with no check, and a service API write could be previewed and confirmed by the calling agent itself. Both now follow `THEBE_MCP_WRITES`, so setting it to `off` really makes `/mcp` read-only.
- `/mcp` follows the Streamable HTTP transport more closely: notifications get `202 Accepted` (was `204`), `GET` and `DELETE` answer `405` with `Allow: POST` (was `404`), and `initialize` returns the client's protocol version when it is `2025-06-18` or `2025-03-26`, otherwise `2025-06-18`.
- The audit log is on by default: it writes `audit.jsonl` in the agent store directory. Before, it was written only when `THEBE_AUDIT_PATH` was set, which no deployment did, so `GET /v1/audit` was always empty.
- `service_api_discover` matches every word of a query in any order; "list containers" no longer needs the exact phrase.
- Creating a session with no configured model answers `409 no_model_configured`, and asking for a model that is not available answers `404 model_not_found`; both were an unexplained `500`.

### Changed

- Over `/mcp`, a provider MCP server's tool counts as a write unless its permission is `read`. Core takes that from the tool's `readOnlyHint`, or from `permission: "read"` on the server in `.thebe/mcp.json`, so a provider tool without either is treated as a write; with `THEBE_MCP_WRITES=off` it is refused.
- Host bash isolation is pinned `@anthropic-ai/sandbox-runtime` 0.0.80 (Seatbelt / bubblewrap). Unset `THEBE_SANDBOX` means on for a host and off inside a container. The TUI and graphical clients can turn that host sandbox off; the command guard stays on. There is no automatic bypass. `THEBE_SANDBOX=off` still forces it off. `os`, `auto`, `vm`, `gondolin`, `bwrap`, `docker`, `seatbelt` and any other value are ignored, the same as leaving the variable unset.
- Sandboxed bash asks before reaching a host that is not allowed yet, the same shape as Claude Code. Allowing once covers that command. Remembering the host stores it on the Core. Two sandboxed commands at once are not asked, because the connection cannot be attributed. Bypass does not enter the sandbox, so its network stays open.
- `GET /v1/system/isolation` `sandbox.mode` is `off` or `os`. `sandbox.backends` is gone, and `fallback` is always false. A missing dependency refuses commands; `thebe doctor` exits 1.

- The command guard reads a command as shell before its text rules apply. `rm -r -f /`, `r''m -rf /`, `rm -rf "$HOME"`, `cd / && rm -rf *`, `sh -c '…'`, `eval`, `find / -delete` and `chmod -R` on the root are blocked; `curl … | sh`, a run-time-built shell command, a command name known only at run time and reads of SSH or cloud credentials ask first. The parser loads at startup; without it the text rules decide alone.
- Permission modes are read by their four names only. The old `ask`, `read-only`, `full-access` and `default` spellings are no longer accepted: a `config.json` that still holds one falls back to `manual`, and an API call with one gets `400`. `POST /v1/session/{id}/full-access` still switches `bypassPermissions`.
- `bypassPermissions` no longer needs `THEBE_FULL_ACCESS`. The variable is ignored and does not start the process in bypass. The TUI and graphical clients ask before turning it on. A session's own mode is still not inherited by subagents, schedules, background goals, `/mcp`, or non-interactive turns.
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
  schedules, background goals, `/mcp` callers, or non-interactive turns.
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
  (`THEBE_DOCKER_PROXY_URL`). Arcane wins when configured; the approved
  `container.restart` path is unchanged; `ResourceRef.provider` gains `docker`.
- A single-container deployment. Build the image from this repository. Durable state stays in `/data`.
