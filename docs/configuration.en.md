# Thebe configuration guide

English | [简体中文](configuration.md)

For deployment and operations (container shape, production variables, TLS,
health checks, upgrade, backup, release gate) see [DEPLOYMENT.md](DEPLOYMENT.md).

## Files and directories

User configuration lives in:

```text
~/.thebe/config.json
```

Files managed by the Pi runtime adapter (`models.json`, `auth.json`, and so on) live in:

```text
~/.thebe/agent/
```

UI and agent settings belong in `config.json`; do not mix them into the Pi agent
files. Configuration files can contain provider addresses and the agent
directory can contain credentials. Never commit or share them.

Override the defaults with environment variables:

```bash
export THEBE_CONFIG_DIR=/path/to/thebe-config
export THEBE_AGENT_DIR=/path/to/pi-agent
export THEBE_AGENT_STORE_DIR=/path/to/thebe-session-metadata
export THEBE_WORKSPACE_DIR=/path/to/project
export THEBE_OUTPUT_DIR=/path/to/project/.thebe/outputs
```

- `THEBE_CONFIG_DIR`: the config directory; the file is `$THEBE_CONFIG_DIR/config.json`. When only this is set, the Pi agent directory defaults to `$THEBE_CONFIG_DIR/agent`.
- `THEBE_AGENT_DIR`: the Pi agent files only.
- `THEBE_AGENT_STORE_DIR`: session, goal, and subagent metadata. Pi transcripts are not stored here.
- `THEBE_WORKSPACE_DIR`: the workspace for file tools and the TUI when `workspacePath` is not set in the config file. If neither is set, Core refuses to start; it never falls back to the process working directory.
- `THEBE_OUTPUT_DIR`: the default directory for generated documents the user explicitly asks to save. `outputDirectory` in the config file takes precedence.
- `THEBE_TOOL_RESULT_COMPACTION` (optional, off by default): set `on` to shorten, before each model call, tool results the model has already answered from (to about 3000 characters in the same turn, about 1200 from earlier turns; images from earlier turns are dropped). Results that arrived after the model's last message stay whole and the session record is unchanged. It lowers input size but rewrites text the provider has already seen, which forfeits prompt-cache hits from that point, so enable it only when input size matters more than cache reuse.

## Managing settings

In the TUI:

- `/config` opens `config.json` in your external editor (created safely if missing).
- `/config path` prints the real paths of the config file, Pi agent directory, workspace, and output directory.
- `/settings` edits common settings.

Restart after editing by hand so every setting takes effect.

The HTTP server also exposes `GET/PATCH /v1/settings/agent`. It returns the
effective settings and where each field came from (`configured`, `default`,
`environment`, or `derived`). HTTP may only change `autoCompact`, `autoSummary`,
and `autoSummaryDelayMs` (clamped to 60 s to 15 min). Concurrency limits, the
workspace, and the output directory are startup or authorization boundaries:
changing concurrency returns `409 restart_required`, and paths are read-only.
The default permission mode uses `GET/PATCH /v1/settings/permissions`; one session's mode uses `GET/PUT /v1/session/{id}/permissions`. Both write to the same
`config.json`. Enabled skill, extension, and prompt resources are also stored
there as identity, version, source, and kind metadata, never as skill bodies or
file contents.

## Settings reference

```json
{
  "externalEditor": "nvim",
  "tuiMode": "regular",
  "theme": "dark",
  "defaultThinkingLevel": "high",
  "autoCompact": true,
  "autoSummary": true,
  "autoSummaryDelayMs": 120000,
  "permissionMode": "manual",
  "maxSubagentConcurrency": 3,
  "maxSubagentsPerParent": 2,
  "enabledResources": [
    {
      "kind": "skill",
      "identity": "demo-skill",
      "version": "1.0.0",
      "source": "thebe://skills/demo-skill"
    }
  ],
  "steeringMode": "one-at-a-time",
  "followUpMode": "one-at-a-time",
  "hideThinking": false,
  "quietStartup": false,
  "fullscreenExitOutput": "transcript",
  "fullscreenScrollbar": "auto",
  "workspacePath": "/path/to/project",
  "outputDirectory": "/path/to/project/.thebe/outputs"
}
```

- `autoSummaryDelayMs` is in milliseconds; `60000` or `120000` summarizes after the user has been idle for one or two minutes.
- `permissionMode` is the host default for new sessions: `plan`, `manual`, `acceptEdits`, or `bypassPermissions` (see [Permission modes](#permission-modes)). Only these four names are read. You can also change it at runtime with `/permissions` or the settings menu.
- `maxSubagentConcurrency` and `maxSubagentsPerParent` cap global child concurrency and per-parent concurrency for one-shot in-memory subagents (clamped to 1 to 16; a profile's `maxTurns` is clamped to 1 to 50). Normal sessions are unaffected.
- `workspacePath` is the mandatory workspace authorization boundary. Absolute paths are used as given; relative paths resolve against the Thebe config directory, not the launch directory. `read`, `ls`, `find`, and `grep` inside the workspace do not prompt; reads outside it need confirmation. `AGENT.md`, `AGENTS.md`, and `CLAUDE.md` are treated like any other file: readable inside the workspace, confirmed outside. `bash`, `write`, and `edit` follow the permission mode.
- `outputDirectory` is only the default location when the user explicitly asks to save a generated document. Ordinary answers are shown in the message.

## Model providers and sign-in

Model providers are managed by the Pi runtime adapter. List and configure them
from the TUI settings or through `GET /v1/provider`; credentials are kept in the
agent directory, never in `config.json`. `POST /v1/provider/{id}/test` checks a
provider with a real probe.

## Service connections

Each service appears in the capability catalog only when all of its required
variables are set. Credentials stay inside the adapter and never appear in tool
arguments or capability metadata. The `THEBE_`-prefixed names
(for example `THEBE_NAVIDROME_BASE_URL`) are equivalent aliases.

### Arcane (containers and activity)

```bash
export ARCANE_BASE_URL=http://127.0.0.1:3552
export ARCANE_API_KEY=your-arcane-api-key
export ARCANE_ENVIRONMENT_ID=0   # optional; 0 is Arcane's local environment
```

Provides container list, inspect, logs, status summary, restart, and start. With a complete address and key, Arcane's background activities
(image pulls, updates, scans) also feed the Activity feed as background tasks
(`provider=arcane`). Core reads `/api/environments/{id}/activities` (latest 25,
newest first), redacts and truncates error text, and the app's "stop" calls
`/api/environments/{id}/activities/{activityId}/cancel`. A finished activity
returns 409 "already finished"; Arcane versions without activity cancellation
return 404. Without credentials neither the container capabilities nor the
activity source is registered.

### Containers without Arcane (Docker Engine API via docker-socket-proxy)

With no Arcane, Core can reach the Docker Engine API through a **restricted**
`docker-socket-proxy` (ADR 0003). Arcane wins when it is configured:

```bash
export THEBE_DOCKER_PROXY_URL=http://127.0.0.1:2375   # proxy root, must be an http(s) URL
# export THEBE_DOCKER_API_VERSION=v1.43               # optional; no version prefix by default
```

Core only talks to that proxy root: it never opens `docker.sock`, never accepts a
host from a request, and refuses redirects. The proxy should expose only the read
endpoints and `POST /containers/*/restart`; reach it over loopback or Tailscale and
publish nothing. The reads map to the same `container.*` surface, and the only
write (`container.restart`) still follows approval → execute → verify → receipt and
is never attached to the model tool loop. `ResourceRef.provider` gains a `docker`
value. Logs may be a multiplexed stream (non-TTY) or plain text (TTY/proxy); Core
demultiplexes the framed form and falls back to text.

### OpenList and the acquisition pipeline

```bash
export THEBE_OPENLIST_BASE_URL=https://openlist.example.com
export THEBE_OPENLIST_TOKEN=your-openlist-token
```

(`OPENLIST_BASE_URL` and `OPENLIST_TOKEN` also work.) This registers the
`strm.repair` capability and the file tools. It uses OpenList's `/api/fs/get`,
`/api/fs/search`, and `/api/fs/put` to find candidates (regular media plus HLS
`.m3u8` and DASH `.mpd` playlists), write the STRM back, and read it again to
verify. The token is used only by the adapter.

With qBittorrent (`THEBE_QBITTORRENT_URL`, `_USERNAME`, `_PASSWORD`), OpenList,
and an Emby or Jellyfin API key configured, Core exposes the acquisition tools:
`download.add/list/status/pause/resume/delete`,
`files.list/mkdir/copy/move/offline_download`, `library.scan`, and
`library.refresh_item`. With `THEBE_PROWLARR_URL` and `THEBE_PROWLARR_API_KEY` it
also exposes `resource.search` and `pipeline.acquire/advance/status`: a
deterministic job (download, copy, scan, verify) with bounded retries, persisted
in `<agent store>/pipeline-jobs.json`. Writes need approval.

`THEBE_ARIA2_URL` (and `THEBE_ARIA2_SECRET`, aria2's `rpc-secret`, when it has one) adds aria2 as a second
download engine behind the same `download.*` tools. `download.add` sends magnets and `.torrent` links to
qBittorrent and every other link to aria2 unless `engine` names one; `download.list` merges both and names an
engine that did not answer in `unreachable`. Every download carries `engine`, `id`, `phase` (`queued`,
`downloading`, `paused`, `error`, `completed`), `badges` and `capabilities`, the same vocabulary the App's
Downloads page uses (`contracts/download-states.json`). aria2's RPC cannot delete files: an unfinished
aria2 download offers `remove_with_files` because removing it makes the owner's own `on-download-stop` script
clean up; a finished one cannot have its files deleted through aria2 and offers only `remove`.

An acquisition job can start from a torrent or from a network-drive transfer:
`pipeline.acquire` with `kind: "cloud_transfer"` and a `transferSource` fetches
the share/direct link through OpenList's offline download, then runs the same
place → scan → verify steps. Core keeps jobs acquired in the running process
moving on its own (every minute),
so an import finishes while the phone is asleep. A job restored after a Core
restart is not auto-resumed — call `pipeline.advance` to continue it — and a
failed job is never retried automatically.

- `download.pause` and `download.resume` take `hashes` (1 to 20 download ids: torrent info-hashes, or aria2 ids when aria2 is configured; there is no "pause all"), keep the task and files, and need approval. qBittorrent 5 uses `stop`/`start` and 4.x uses `pause`/`resume`; Core detects the version. Unknown hashes are rejected rather than silently ignored. If the downloader lacks the operation, the tool does not appear.
- `download.delete` also takes `hashes` (1 to 20), is irreversible, and needs approval. `deleteFiles` must be explicitly `true` or `false`: `false` removes only the task, `true` also deletes files on disk. A missing or non-boolean value is rejected; nothing is deleted by default.

qBittorrent also supplies native download tasks to the Activity feed and, for
completed tasks, bounded `task_output` Artifacts (Web API v4 and v5).

### Navidrome (music)

```bash
export NAVIDROME_BASE_URL=http://127.0.0.1:4533
export NAVIDROME_USERNAME=thebe
export NAVIDROME_PASSWORD=your-password
# optional: retry address if the main one is unreachable; also the base for later playback URLs
export NAVIDROME_FALLBACK_URL=https://music.example.com
```

Needs the URL, username, and password together. Uses the Subsonic API for recent
and most-played albums, artists, playlists, songs, search, artist details,
lyrics, and the playback queue. `navidrome.queue` returns uniform song entries
(direct or transcoded stream URL, cover, title, artist, album, optional lyrics);
Core does not play audio, the client does. Creating, updating, and deleting
playlists are writes and can only run through an agent session's runtime
approval; direct MCP or capability invoke returns 403. The password stays inside
the adapter.

For the model, library, search, and artist tools return compact observations:
all returned candidates keep their order, names, IDs, and album/artist
relations; cover art and audio-encoding fields are dropped. Artist biographies
are capped at 2000 characters with `biographyTruncated:true`. Direct capability
responses keep the full schema, and queue URLs, lyrics, and write receipts are
never trimmed.

### Emby, Jellyfin, and Immich

```bash
export EMBY_BASE_URL=http://127.0.0.1:8096
export EMBY_API_KEY=your-emby-key
export EMBY_USER_ID=your-user-id

export JELLYFIN_BASE_URL=http://127.0.0.1:8096
export JELLYFIN_API_KEY=your-jellyfin-key
export JELLYFIN_USER_ID=your-user-id

export IMMICH_BASE_URL=http://127.0.0.1:2283
export IMMICH_API_KEY=your-immich-key
```

These register read-only capabilities. Emby uses `X-Emby-Token` and the `/emby`
prefix; Jellyfin uses `Authorization: MediaBrowser Token="..."` with no prefix.
`emby.search` and `jellyfin.search` find items by title, person, or year and
return item ids; `emby.item` and `jellyfin.item` read overview, type, year,
genres, and cast. `communityRating` is the media server's own rating.
`immich.search` calls `POST /api/search/smart` for semantic search by image
content; filename, date, and city filters still use the metadata listings. If
machine learning is unavailable the error is surfaced, not treated as an empty
library.

### Other services (OpenAPI)

Add one HTTP service by setting its base URL and an OpenAPI 3 or Swagger 2 document:

```bash
export THEBE_SERVICE_APIS='[{"id":"my-service","baseURL":"http://192.168.1.10:8080","openapiPath":"/openapi.json","headersEnv":{"X-API-Key":"MY_SERVICE_API_KEY"}}]'
export MY_SERVICE_API_KEY=...
```

Operations are loaded from the OpenAPI document for discovery and reads, and
writes need approval. Header values are environment references and are never
sent to the model.

- `openapiPath` is fetched from `baseURL`. When the service does not serve its
  spec there, use `openapiURL` with an absolute `http(s)` URL instead (the spec is
  fetched without the API's auth headers, which stay on the API host).
- `readOperations` is the operator's read-only allow-list — operation IDs or
  `METHOD /path` entries. Each allow-listed read operation becomes its own tool
  (`service_api.<id>.<operationId>`) with a real input schema, listed on `/mcp`
  and in `/v1/capabilities`, so an MCP client gets named tools instead of one
  generic call. Everything else stays behind `service_api_discover` /
  `service_api_write` with runtime approval; operations that require a header
  parameter are never exposed this way (headers are operator-owned).
- Less typing, same trust model: `readMethods` (e.g. `["GET","HEAD"]`) treats
  every operation with those methods as read-only, and
  `trustReadOnlyAnnotations: true` additionally trusts the document's own
  read-only hints. Both are **off unless you set them** — a remote document can
  never mark itself read-only on its own.
- `excludeOperations` (operation IDs or `METHOD /path`) and `excludeTags` hide
  operations from discovery and the named tools, and every request that matches
  one is refused — reads, writes and approved calls alike. Use them for admin or
  destructive endpoints that the model should never reach, whatever it asks.
- `writeOperations` (operation IDs or `METHOD /path`) exposes chosen writes as
  two-phase tools. Calling one performs **no change**: it returns a
  `preview` (`method`, `path`, `body`) and a single-use `confirmToken` that
  expires in five minutes. `service_api.confirm` with that token executes exactly
  the previewed request. Both the preview and the execution are audited, and the
  App/MCP client is expected to show the preview before confirming. The model's
  own write path stays `service_api_write` with runtime approval.
- Run `node scripts/accept-service-api.mjs` to check a configured service end to
  end (it spawns Core, lists the per-operation tools, discovers operations, and
  invokes a read; `--preview` checks the two-phase write).

## MCP servers

External MCP servers go in `.thebe/mcp.json` under `mcpServers` (the global
`~/.thebe/mcp.json` and `.mcp.json` are also read). Model sessions connect to
them through Pi's built-in MCP extension; Core does not keep MCP connections of
its own. Tool names are `mcp__<server>__<tool>`.

```json
{
  "mcpServers": {
    "notes": {
      "command": "notes-mcp",
      "args": ["--stdio"],
      "env": { "API_KEY": "..." },
      "description": "Search and read notes",
      "exposure": "codemode",
      "permission": "confirm",
      "disabled": true
    }
  }
}
```

- `exposure`: `codemode` (default; tools can only be called from `codemode` scripts and take no space in the model's tool list), `deferred` (declared after `tool_search` loads them), `direct`, or `hidden`.
- URL servers accept a `headers` map (string values) sent on every request, so a provider's own MCP that needs a token — for example `"headers": { "X-Api-Key": "..." }` or a service-specific header such as `{"sqmusic":"<JWT>"}` — is attached without Core growing a vendor adapter. Prefer this over hard-coding the service: point Core at the provider's MCP and it gets those tools instead. `headers` are stored in `.thebe/mcp.json` (mode `600`), never logged, and never sent anywhere but the configured URL.
- `permission`: servers other than `read` need approval on every call. If omitted, the tool's own `readOnlyHint` decides; with no hint, approval is required.
- Scripts run in Pi's QuickJS sandbox and reach the outside only through tools. Every MCP call from a script still goes through policy, approval, audit, and redaction. The `models` global in `codemode` is disabled.
- stdio servers inherit only basic variables such as `HOME` and `PATH`, plus their own `env`, never Core's environment.
- Newly added servers are disabled. Enable, disable, or delete them with `/v1/extensions/mcp/servers`; sessions pick up the change on the next reload.
- From the terminal: `thebe mcp add <name> --url <url> --header K=V` (repeat `--header`, `--env`, `--arg`), then `thebe mcp enable <name>`; `thebe mcp list` and `thebe mcp tools` show the inventory, and `thebe mcp remove <name>` deletes a server Thebe wrote.
- Web search without running SearXNG: point Core at a search MCP server. Parallel's keyless endpoint works as `{"mcpServers": {"parallel": {"url": "https://search.parallel.ai/mcp", "description": "Web search and page fetch", "exposure": "deferred"}}}` and gives `mcp__parallel__web_search` and `mcp__parallel__web_fetch` after `tool_search` loads them. Queries and fetched URLs go to Parallel, and its free tier is limited. In a 2026-10-14 check, adding `"permission": "read"` to this entry stopped its tools appearing in `tool_search`, so leave `permission` out; calls ran without an approval prompt in that check.
- Which services ship their own MCP server (Home Assistant, Grafana, Docker, GitHub, Kubernetes today) is recorded in `PROVIDER-MCP.md`; an opt-in live check connects to real servers with `THEBE_MCP_LIVE=1 npx vitest run src/adapters/mcp/live.test.ts`.

## Skills

The repository ships skills under `.thebe/skills/`: `navidrome-recommend`,
`library-lookup`, `photo-find`, `container-triage`, `download-monitor`, and
`media-acquire`. Copy the directory to the workspace's `.thebe/skills/` or to the
Core user's `~/.thebe/skills/`, then enable it in the app's Skills settings or
with `PATCH /v1/skills/<name>` and body `{"enabled":true}`. In a container, put
the skills in the mounted workspace or a persistent `HOME`. Having them only in
the development repository does not enable them anywhere.

At runtime only the name, description, and path of enabled skills are added to
discovery; the body is read on demand. Skills report honestly when the tools
they need are not configured instead of inventing results.

- `container-triage`: read-only container status and log triage (`container.*`); restarts are not called by the model and still go through the diagnosis approval flow. Needs a container provider such as Arcane.
- `download-monitor`: follows download and import progress with `download.*`, `pipeline.status`/`pipeline.advance`, and `files.list`.
- `media-acquire`: `resource.search` finds sources, the user picks one, and `pipeline.acquire` downloads and imports it. Needs an indexer, downloader, file manager, and media server.

## Command risk guard (homelab and NAS heuristics)

Before approval, `bash`, `write`, and `edit` pass through a command risk guard
(`src/agent/security/command-risk.ts`) with four levels:

| Risk        | Behavior                                                                         | Examples                                                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical`  | **Denied by policy** (never reaches approval; the model sees `denied by policy`) | `rm -rf /`, bulk deletes of NAS data directories such as `/volume1`, `zfs destroy`, `zpool destroy`, `mkfs.*`, `mke2fs`, `ntfsclone --overwrite`, `ntfswipe`, `exportfs -ua`, `mdadm --stop/--zero-superblock`, `fdisk`/`parted`, `dd of=/dev/sdX`, fork bombs, `kill -9 1`, `docker run -v /:... --privileged`       |
| `dangerous` | Still needs human approval (shown as high risk)                                  | shutdown or reboot, flushing the firewall, `docker rm -f $(ps -aq)`, `docker volume prune -f`, mounting `docker.sock`, `ntfsfix`/`ntfsresize`, force-unmounting shared storage, stopping smbd, nfs-server, sshd, or docker, writing system paths such as `/etc/...`, writing or modifying files outside the workspace |
| `caution`   | Allowed, with a warning recorded                                                 | restarting or stopping containers or system services, `chmod -R`, `chown -R`, scrub, `exportfs -a`                                                                                                                                                                                                                    |
| `safe`      | Runs normally                                                                    | read-only checks such as `docker ps`, `zpool status`                                                                                                                                                                                                                                                                  |

- Docker and Podman commands get a further container guard (`docker-command-guard.ts`): privileged containers with a host-root mount, host-root bind mounts, `--privileged`, `docker.sock` mounts, volume prune.
- Storage systems recognized: ZFS, Btrfs, EXT4 (including xfs and f2fs), NTFS, NFS; the result carries a `storageSystem` field.
- Workspace escapes: writing outside the workspace, or `rm`/`mv`/`cp`/`chmod`/`chown` on paths outside it, is raised to `dangerous`.
- Direct calls to the Docker Engine API (`curl --unix-socket /var/run/docker.sock ... /containers/create`, podman remote) go through `docker-api-guard.ts`: `HostConfig.Privileged=true`, `Binds` with the host root or `docker.sock`, `CapAdd: SYS_ADMIN|ALL`, and `/volumes/prune` or `/system/prune` are always `critical`. If the `/containers/create` body cannot be parsed, it is downgraded to `dangerous` (human review), not allowed.
- The guard is always on. Only `bypassPermissions` (below) lifts it, for one session.

## Permission modes

One setting decides how much a session may do without asking. The names are Claude Code's.

| Mode                | What runs without asking                                                                                       | What is asked or refused                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `plan`              | Reads inside the workspace                                                                                     | Everything that changes something is refused                                                                            |
| `manual`            | Reads inside the workspace                                                                                     | `bash`, `write`, `edit`, memory and write tools of services are asked each time                                         |
| `acceptEdits`       | `write` and `edit` inside the workspace (never `.git`), and `bash` when a sandbox that confines it is in place | Anything the command guard flags, paths outside the workspace, `bash` with no sandbox, `memory`, MCP and service writes |
| `bypassPermissions` | Everything; the command guard and the sandbox are lifted                                                       | Nothing. Turn it on in the TUI or the App; both ask first                                                               |

`acceptEdits` follows Codex's on-request policy with a restricted sandbox: the sandbox, not a list of
"safe" commands, is what makes running a command without asking acceptable, so with no sandbox
running a command is asked about as usual. Even with one, a script that `tree-sitter-bash` cannot read, or
that holds a forced `rm` (found through `sudo`, `env`, `trap` and `bash -c`, as Codex's check does), is asked about. `.git` stays read-only as it does in Codex's
workspace-write sandbox.

- The host default comes from `permissionMode` in `config.json` (default `manual`). A session can set its own with `PUT /v1/session/{id}/permissions` (`{"mode": "plan"}`; `{"mode": null}` returns to the host default), and `GET` on the same path says which mode it runs in.
- A subagent, a scheduled occurrence, a background goal, an `/mcp` caller and a non-interactive turn take the host default, not the session's own mode.
- A remembered denial, redaction and the audit log apply in every mode. `critical` commands are refused in every mode except `bypassPermissions`.
- `POST /v1/session/{id}/full-access` with `{"enabled": true|false}` still works and is `bypassPermissions` on or off.

### `bypassPermissions`

Session-scoped, and it can also be the host default. It lifts the command guard, the OS sandbox and tool approval, and leaves redaction and audit in place.

No environment variable is required. `THEBE_FULL_ACCESS` is ignored, the same as leaving it unset: it does not start the process in bypass. Choosing it with `/permissions` or the settings menu in the TUI, or in the App's Agent settings, asks first. A confirmed host default is saved in `config.json`. Schedules, subagents, background goals and `/mcp` use the host default; they do not inherit bypass that one session turned on for itself.

The model reads untrusted content (web pages, tool output, remote MCP), so in this mode a mistaken command can damage the host: use it only when needed. Full access applies on the next command; a new session is not required.

## Command sandbox

Model `bash` and the Core process are different boundaries. There is no backend menu.

- **Container deployment** (the release shape): `/.dockerenv` or `/run/.containerenv` means no sandbox is started. Leave `THEBE_SANDBOX` unset. Do not nest bubblewrap or a VM inside the container.
- **Host install**: the default is pinned `@anthropic-ai/sandbox-runtime` (the same Seatbelt / bubblewrap Claude Code uses). The TUI settings menu and the App's Agent settings can turn it off, and both ask first; the command guard stays on. That is not bypass, and there is no automatic bypass. `THEBE_SANDBOX=off` and a container force it off, and the switch cannot override that. Full access (`bypassPermissions`, confirmed in the TUI or the App) also lifts the sandbox.

`os`, `auto`, `vm`, `gondolin`, `bwrap`, `docker`, `seatbelt` and any other value are ignored, the same as leaving the variable unset: a host still uses the OS sandbox, and a container still stays off. They are not mapped, and they do not fail startup.

The policy is fixed, not an environment variable:

- Write: the workspace and the temp directory.
- Read: open, except `~/.ssh`, `~/.aws`, `~/.gnupg` and `~/.thebe`.
- Network: an allowlist, empty by default, the same shape as Claude Code. Sandboxed `bash` asks the first time it reaches a host. Allowing once covers that command; remembering the host writes `sandboxAllowedDomains` in `config.json` and later commands are not asked. A remembered denial writes `sandboxDeniedDomains`. Two sandboxed commands at once cannot be told apart, so that connection is denied. `web_search` does not use this list. Bypass does not enter the sandbox, so its network is open.

A missing dependency refuses the command instead of running it bare. Linux needs bubblewrap, socat and ripgrep; macOS uses `sandbox-exec` and does not need ripgrep. `thebe doctor` exits 1 in that case. `GET /v1/system/isolation` reports `sandbox.mode` as `off` or `os` and no longer returns `backends`.

The command guard, the workspace confinement and the Docker API guard (privileged containers, host-root and
`docker.sock` mounts, volume prune) are always on and have no switches.

## Judgment Model (off by default)

The Judgment Model is not a chat provider. By default every site takes its
traditional path.

```bash
export THEBE_JUDGMENT_MODEL=off
```

To enable the first adapter (Jev):

```bash
export THEBE_JUDGMENT_MODEL=jev
export THEBE_TYPESAFE_API_KEY=...
# optional: which sites may call it (default: all catalog sites)
# export THEBE_JUDGMENT_SITES=all
# export THEBE_JUDGMENT_SITES=home.attention,intent.capability
# export THEBE_JUDGMENT_SITES=none
export THEBE_TYPESAFE_BASE_URL=https://api.typesafe.ai/v1/systemone
export THEBE_JEV_MODEL=jev-latest
```

If it is unset, set to anything other than `jev`, missing the API key, not
enabled for the site, or the call fails, the site falls back to its traditional
path. When on, that site's `state` is sent to TypeSafe. There is no app setting
for it.
