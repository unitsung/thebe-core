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
- `THEBE_MODEL_RESULT_LIMIT` (optional, unlimited by default): a positive integer (minimum `2000`, suggested `12000`) that caps how many characters of one custom-tool result enter the model context. JSON keeps the leading entries and states how many were omitted; logs and plain text keep the tail. It only affects what the model sees: capability and MCP callers still get the full result, and Pi built-in tools (`read`, `bash`, and so on) are unaffected.

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
Permission mode uses `GET/PATCH /v1/settings/permissions`. Both write to the same
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
  "permissionMode": "ask",
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
- `permissionMode` is `ask`, `read-only`, or `full-access`. `ask` prompts before approval-gated tools such as `bash`, `write`, and `edit`; `read-only` refuses them; `full-access` allows them automatically. `full-access` only skips the application-level confirmation and is not an OS sandbox. You can also change it at runtime with `/permissions ask|read-only|full-access` or the settings menu.
- `maxSubagentConcurrency` and `maxSubagentsPerParent` cap global child concurrency and per-parent concurrency for one-shot in-memory subagents (clamped to 1 to 16; a profile's `maxTurns` is clamped to 1 to 50). Normal sessions are unaffected.
- `workspacePath` is the mandatory workspace authorization boundary. Absolute paths are used as given; relative paths resolve against the Thebe config directory, not the launch directory. `read`, `ls`, `find`, and `grep` inside the workspace do not prompt; reads outside it need confirmation. `AGENT.md`, `AGENTS.md`, and `CLAUDE.md` are treated like any other file: readable inside the workspace, confirmed outside. `bash`, `write`, and `edit` follow the permission mode.
- `outputDirectory` is only the default location when the user explicitly asks to save a generated document. Ordinary answers are shown in the message.

## Model providers and sign-in

Model providers are managed by the Pi runtime adapter. List and configure them
from the TUI settings or through `GET /v1/provider`; credentials are kept in the
agent directory, never in `config.json`. `POST /v1/provider/{id}/test` checks a
provider with a real probe.

### Google / Antigravity (OAuth)

`google-antigravity` signs in with a Google account and talks to Cloud Code
Assist (`https://cloudcode-pa.googleapis.com/v1internal`). It supports OAuth
only, no API key, and appears in `GET /v1/provider` with `authMethods: ["oauth"]`.

The OAuth client secrets are not bundled with the code. Before sign-in or token
refresh, set the one for the client you use; otherwise the call fails with a
clear error:

```bash
export THEBE_GOOGLE_ANTIGRAVITY_CLIENT_SECRET=...    # Antigravity
export THEBE_GOOGLE_GEMINI_CLI_CLIENT_SECRET=...     # Gemini CLI
```

- **Models:** the offline seed has only `gemini-3-pro` and `gemini-3-flash`; the real list comes from `v1internal:fetchAvailableModels` and is cached (`GET /v1/model?provider=google-antigravity`, or "fetch models" in the TUI or app, refreshes it; with `PI_OFFLINE` only the cache is read).
- **Auth:** the provider reads Core's credential file, so Pi sessions, HTTP, the TUI, and the mobile app share one Google session. Logging out invalidates the Pi side on its next request; no copy is left in Pi's `auth.json`.
- **Transport:** `v1internal:streamGenerateContent?alt=sse` with the Cloud Code Assist envelope. `THEBE_ANTIGRAVITY_ENDPOINT` points it at a local proxy or test server.

Headless sign-in (used by the TUI settings and the mobile app):

```bash
# 1. Get the authorization URL (the response has url / instructions, pending is true)
curl -s -X POST localhost:8787/v1/provider/google-antigravity/oauth/authorize
# 2. After signing in in a browser, send back the code or the whole callback URL
curl -s -X POST localhost:8787/v1/provider/google-antigravity/oauth/callback \
  -H 'content-type: application/json' \
  -d '{"code":"http://localhost:51121/oauth-callback?code=..."}'
# 3. Sign out
curl -s -X POST localhost:8787/v1/provider/google-antigravity/oauth/logout
```

Credentials are written to `antigravity.json` in the agent directory (mode 0600),
with access and refresh tokens, expiry, the Google account email, and the Cloud
project id (discovered with `loadCodeAssist`, created with `onboardUser` if
needed).

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

- `download.pause` and `download.resume` take `hashes` (1 to 20 info-hashes; there is no "pause all"), keep the task and files, and need approval. qBittorrent 5 uses `stop`/`start` and 4.x uses `pause`/`resume`; Core detects the version. Unknown hashes are rejected rather than silently ignored. If the downloader lacks the operation, the tool does not appear.
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
- `permission`: servers other than `read` need approval on every call. If omitted, the tool's own `readOnlyHint` decides; with no hint, approval is required.
- Scripts run in Pi's QuickJS sandbox and reach the outside only through tools. Every MCP call from a script still goes through policy, approval, audit, and redaction. The `models` global in `codemode` is disabled.
- stdio servers inherit only basic variables such as `HOME` and `PATH`, plus their own `env`, never Core's environment.
- Newly added servers are disabled. Enable, disable, or delete them with `/v1/extensions/mcp/servers`; sessions pick up the change on the next reload.

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
- `THEBE_COMMAND_GUARD=off` turns this guard off entirely, leaving everything to approval.

## Command sandbox

Core and the runtime do not provide an OS sandbox by default. The supported
boundary is the container; these optional backends isolate the `bash` tool.
They are off by default.

- **bubblewrap** (`THEBE_SANDBOX=bwrap`, Linux): read-only host root, tmpfs `/tmp`, remounted `/dev` and `/proc`, only the workspace writable, `--unshare-all`, `--cap-drop ALL`, `--die-with-parent`. The network stays on unless `THEBE_SANDBOX_NETWORK=deny`. If `bwrap` is missing (macOS, ordinary containers), Core falls back to running unsandboxed and logs a warning.
- **docker** (`THEBE_SANDBOX=docker`): a throwaway container with `--rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`, `--network none` by default, and only the workspace mounted read-write. The image is `THEBE_SANDBOX_IMAGE` (default `alpine:3`). Without a Docker daemon it falls back to local execution with a warning.
- **seatbelt** (`THEBE_SANDBOX=seatbelt`, macOS development): `sandbox-exec` with a generated profile; writes are limited to the workspace and `TMPDIR`, network denied by default.
- **gondolin** (`THEBE_SANDBOX=gondolin`): a throwaway micro-VM (QEMU) with hardware isolation. The workspace is mounted at `/workspace` in the guest and paths that leave it throw; HTTP egress is mediated (`THEBE_SANDBOX_NETWORK=deny` means an empty allowlist). Missing package or QEMU gives a clear error with the fix, and never silently falls back to local execution.

```bash
# gondolin setup
npm install @earendil-works/gondolin@0.13.0                   # optional dependency; may already be installed
brew install qemu                                           # Linux: sudo apt install qemu-system-arm
THEBE_SANDBOX=gondolin THEBE_SANDBOX_NETWORK=deny thebe     # first start downloads a ~200 MB guest image
```

`GONDOLIN_DEFAULT_IMAGE` selects the guest image (default `alpine-base:latest`).
For the strict NAS setup use `THEBE_SANDBOX=bwrap`, `THEBE_SANDBOX_NETWORK=deny`,
and leave `THEBE_COMMAND_GUARD` on.

## Scenario profiles

`THEBE_SCENARIO` bundles the safety switches into presets:

| Scenario          | Command guard | Workspace escape | Sandbox                | Docker guard                           |
| ----------------- | ------------- | ---------------- | ---------------------- | -------------------------------------- |
| `nas-strict`      | on            | forbidden        | `bwrap`                | all (including volume prune)           |
| `homelab-host`    | on            | allowed          | off                    | host-root mounts and volume prune only |
| `microvm-sandbox` | on            | forbidden        | `gondolin`, no network | all                                    |
| `yolo-guarded`    | on            | forbidden        | `bwrap`                | all                                    |

```bash
export THEBE_SCENARIO=nas-strict
```

- An explicit `THEBE_*` variable always overrides the preset (for example `THEBE_SANDBOX=off` overrides only the sandbox).
- Without `THEBE_SCENARIO` the defaults are: guard on, sandbox off, network on, workspace escape forbidden.
- `THEBE_ALLOW_WORKSPACE_ESCAPES=true` allows workspace escapes on its own.
- A scenario is a preset, not a second safety engine; the guard, sandbox, and Docker guard each still decide for themselves.

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
