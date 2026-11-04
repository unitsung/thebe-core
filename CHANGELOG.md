# Changelog

All notable changes to Thebe Core are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Over `/mcp`, `strm.repair` and `sqmusic_download` ran even when the host had set `THEBE_MCP_WRITES=off`, because the write check matched a fixed list of tool names. Core's own tools are now judged by what they declare (the same `effect` that sets their `readOnlyHint`), so any write tool a Core capability adds is held by `THEBE_MCP_WRITES` and by a token's `mcp:write` scope.

### Added

- Schedules have an accept mode, `off`, `observe` or `auto`. A new schedule starts in `observe`: at its due time nothing runs (no session, Goal, write or confirmation) and Core records that it would have run, with the time, the Goal and its scope, as a `schedule_observation` item in `GET /v1/activity`. The App can run it once (`POST /v1/schedules/{id}/run`), switch the schedule to auto (`PATCH /v1/schedules/{id}` with `{"mode":"auto"}`; the next due time runs once) or delete it, and deleting a schedule keeps the Goals it already produced. Schedules stored before this change stay `auto`; a client that creates schedules without a `mode` now gets `observe`. Shared fixtures: `contracts/schedules.json` and `contracts/activity.json`.
- Tickets: a goal the owner asks for (`POST /v1/goals`, `POST /v1/goals/{id}`, `startGoal`) now also produces a ticket with `explicit` strength that wraps it. A ticket's id is derived from its content, so the same trigger accepted twice yields one ticket: send `triggerId` on `POST /v1/goals` to name the request, and sending it again returns the goal it started instead of starting another. `GET /v1/tickets` and `GET /v1/tickets/{id}` read tickets with their derived stage and links to the goal, sessions, runs, receipts and artifacts they wrap; they copy none of that state, and nothing writes a ticket by hand. `/v1/goals/{id}` accepts a session id or a ticket id, and goal responses and Activity items gain `ticketId` when a ticket wraps them. `GET /v1/health` advertises `capabilities.tickets`. Nothing was removed: older Apps ignore the new fields.
- Every audit record written for a call over `/mcp` names the token that made it (`caller`), whichever tool ran, and `GET /v1/audit?caller=<token name>` lists only that token's records, alone or with the other filters, so the owner can spot a misbehaving agent and revoke its token. Records the App's own calls wrote, and older records, have no `caller` and never match the filter. `contracts/audit.json` carries entries with and without a caller for clients to decode.
- Container health is the first event source. When the policy turns `sources["container-health"]` on (`PATCH /v1/policy`, `{"enabled": true}`; it is off until then and nothing is read while off), Core reads the containers every 30 seconds and turns each change (unhealthy, restarting, stopped unexpectedly, recovered) into an immutable Trigger with a stable id on that container's thread. A deterministic Gate checks, in order, that the source is enabled, the kind, the minimum severity (default `warning`), quiet hours (default 23:00 to 08:00; `critical` breaks through) and de-duplication (the same kind on the same container inside 30 minutes is a duplicate), and records one outcome per Trigger: `passed`, `filtered` with its reason, or `duplicate` of the earlier Trigger. Outcomes appear in Activity as `trigger` items (`GET /v1/activity?source=trigger`, stage `ended`). The source saves its read position, so a restart neither replays nor loses a change, and at most one evaluation runs per container at a time. Ten minutes of read failures show as `sources["container-health"].failing` in `GET /v1/health` and make no Trigger.
- Every Activity item now carries a `stage` worked out from its facts and never stored: ended, person (with a reason: not delivered, waiting for an answer, waiting for confirmation, waiting for review, blocked, failed), working (including queued) or idle. `GET /v1/activity?stage=person` is the "needs you" list and `GET /v1/activity/summary` counts it, so the count equals the list. A finished failure asks for the person for 24 hours and then stays in history. aria2 downloads now appear in Activity as background tasks. `contracts/activity.json` pins the shape for the App; `stage` is additive, so an older App still decodes the feed.
- Goal workers and reviewers report `progress`, `waiting`, `ready`, `blocked`, `failed` or `dropped` (nothing to do) through a `goal_report` tool instead of text markers, with at most one question. A Goal stores its latest `report` and open `attention`; `waiting` or `blocked` pauses it at once, and `POST /v1/goals/{id}/answer` (also `/v1/session/{id}/goal/answer`) resumes the same session with the answer and sends no second push. The older `GOAL_STATUS:` / `VERDICT:` footers are still read into a report.
- `/mcp` speaks the MCP protocol versions `2026-07-28` and `2025-11-25` as well as `2025-06-18` and `2025-03-26`. The newest is stateless: no `initialize`, the version and client capabilities travel in each request's `_meta`, the POST carries `MCP-Protocol-Version`, `Mcp-Method` and (for `tools/call`) `Mcp-Name` headers that Core checks against the body (`400` with `-32020` on a mismatch), `server/discover` describes the server, results say `resultType: "complete"`, and `tools/list` and `server/discover` carry `ttlMs` and `cacheScope`. A version Core does not speak gets `400` with `-32022` and the versions to retry with. `tools/list` is now sorted by tool name for every version. Older clients (Claude Code, OpenCode, Codex) get the same answers as before.
- Irreversible deletes are now also judged for the writes Core cannot classify by name, over `/mcp`: a generic OpenAPI write (`service_api_write`, or a per-operation preview) is irreversible when its method is `DELETE` or when a delete-like argument (`deleteFiles`, `deleteData`, `removeData`, `purge`, `wipe`, ...) is true in its arguments, body or query, and an external MCP tool is irreversible when its server declares `destructiveHint: true`; both are refused like `download.delete` with `deleteFiles: true` for a token without `mcp:irreversible`. The operator overrides one operation or tool either way: `irreversibleOperations` on a `THEBE_SERVICE_APIS` entry (`{"deleteTag": false, "POST /recyclebin/empty": true}`) and `"tools": {"prune_cache": {"irreversible": false}}` on a `.thebe/mcp.json` server; a call an override decided leaves an audit record with `override: "irreversible"` or `"ordinary"` (new on audit records; method `service_api.irreversible_override` or `mcp.irreversible_override`, `identity` names the operation or tool, `caller` the token). A remote shell command (`POST /v1/session/{id}/bash`) counts as irreversible as a whole and its audit record says `irreversible: true`. `files.move` and `files.copy` on OpenList now list the destination first and fail at once on an existing name, saying nothing was changed, so they stay ordinary writes. The file tools (`files.list|mkdir|copy|move|offline_download`) are now listed on `/mcp` and in `GET /v1/capabilities` when a file manager is configured. A write Core registers must declare `irreversible: true | false | "by_call"` (`withProductMetadata` throws without it); `tools/list` shows it as `_meta["thebe/irreversible"]`.
- Irreversible deletes over `/mcp` are refused unless the token allows them. Whether a call is one is judged per call (tool plus arguments): `download.delete` with `deleteFiles: true` and `navidrome.playlist.delete` are; deleting only the download task stays an ordinary write. A new token scope, `thebe token create <name> --scope mcp:irreversible` (it includes `mcp:write` and `mcp:read`), allows them for one token; without it the call fails at once with a tool error that says it is an irreversible delete and how to grant the scope, and `THEBE_MCP_IRREVERSIBLE=off` refuses them for every token. An allowed call is audited with `irreversible: true` and the token name (`caller`, new on audit records), and its result says it was irreversible. `--scope` may now be repeated or comma-separated. The download tools (`download.list|status|add|pause|resume|delete`) are now listed on `/mcp` and in `GET /v1/capabilities` when a downloader is configured; before, they could not be reached over `/mcp` at all.
- `GET /v1/usage/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` (or `days=N`, `utcOffsetMinutes=` for the caller's day boundary) answers "what is Thebe costing and doing for me": tokens per day with background work (Goal sessions and anything a schedule started) apart from chats, cache reads reported separately and never counted, an estimated cost, Goal outcomes with completion-time p50/p95 and tokens per Goal, and how long restart confirmations waited. It is computed on the request from the session metadata, session token stats, Goal runs and activity records Core already keeps: nothing new is stored, no collector runs in the background, and nothing is sent anywhere. A session's tokens count toward the day it was last active, and workers' and reviewers' own sessions are not included because Core does not keep their stats. The shared fixture is `contracts/usage.json`.
- A versioned policy at `GET/PATCH /v1/policy`: the owner's rules in plain language (a name and a paragraph each), an accept mode (`off`, `observe`, `auto`), per-source settings and switchable default rule sets (containers, downloads, media library, storage). Every change creates a new immutable version, an update must carry the version it read (a stale one answers 409 `stale_revision`), and `GET /v1/policy/versions/{version}` returns any earlier version. Text in events or tool output cannot change it. Nothing acts on the policy yet.
- `THEBE_MCP_PORT` opens a second port that serves only `POST /mcp`: `/v1/*`, `/docs` and `/openapi.json` are `404` on it, so it is the one port to expose through Tailscale Funnel or a tunnel. The Host and token checks apply as on the main port, which behaves as before. Each token is limited to `THEBE_MCP_RATE_LIMIT` requests per minute (default 120) on that port; past it the caller gets an immediate `429` (`code: "rate_limited"`, `Retry-After`) and other tokens are unaffected. `THEBE_MCP_HOST` sets its bind address. See `docs/DEPLOYMENT.md` section 4.3.
- `Authorization: Bearer <token>` is accepted anywhere `X-Thebe-Token` is, for clients that send a bearer token and cannot set a custom header (Claude's API, most agent frameworks). When a request sends both, `X-Thebe-Token` is the one checked.
- Scoped device tokens: `thebe token create <name> --scope mcp:read|mcp:write` makes a token that works only on `/mcp`. `mcp:read` runs read tools; `mcp:write` also runs write tools, if the host has not turned writes off (`THEBE_MCP_WRITES=off` still wins). A scoped token is refused with `403 token_scope` on every other route, and a write tool refused for want of `mcp:write` answers at once with the command that grants it; nothing waits. A token made without `--scope`, the shared token and `THEBE_TOKEN` keep full access, and a stored scope Core does not know is refused rather than read as full access. `thebe token list` shows each token's scope.
- `tools/list` over `/mcp` shows a token only the tools it may call: a read token lists read tools, a write token lists read and write tools, and a token with no scope lists everything. Irreversible tools stay listed for any token that may write, because they are judged per call. A write scope can be limited to service categories when the token is made: `thebe token create <name> --scope mcp:write --category containers,downloads` (`--category` is repeatable or comma-separated, needs a write scope, and takes the capability categories `files`, `media`, `downloads`, `containers`, `automation`, `diagnostics`, `compute`, `storage`, `network`, `photos`, `other`), and `thebe token list` shows it. A write to a tool outside those categories is refused at once with `mcp_category_not_allowed`, naming the tool's category and the categories the token has; reads are never limited, and the tool list omits the out-of-category write tools. A stored category list Core does not know (or an empty or malformed one) refuses the token with `401` instead of being read as unrestricted.

- Optional push through a separately deployed Push Relay (`relay/`). With `THEBE_PUSH_RELAY_URL` set, Core keeps an Ed25519 signing key, publishes the public half at `GET /v1/push/identity`, accepts a `relayDeviceId` on `POST /v1/devices`, and sends a signed, minimal event to the relay when an approval starts waiting. Unset, nothing is sent. Core still holds no APNs credentials.
- Push notices now go through a durable, idempotent outbox. Notices for one ticket to one device are delivered in order with a sequence number (`seq`) and `ticket`; the head is retried with back-off from 5 to 300 seconds and later notices wait; nothing is lost while the relay is unreachable, three transient relay errors drop the head, a permanent refusal drops it at once, and every drop is recorded with its reason. `GET /v1/health` gains `push` (`pending`, `consecutiveFailures`, `dropped`, `lastError`, `lastDrop`) when push is on. The relay now remembers delivered ids for 24 hours across restarts, lets a retry through after an APNs failure, and passes `id`, `ticket`, `seq` and an `apns-collapse-id` to the device. Upgrade the relay before Core.

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
