# Thebe Core

[简体中文](README.zh-CN.md)

Thebe Core is a homelab agent server with approvals and an audit log. It connects to the services you already run (media library, photos, music, files, downloads, containers) and lets an agent operate them safely: reads run freely, risky actions wait for your approval, and every call is recorded.

Run it on a NAS, a mini PC, a Raspberry Pi or a cloud server. Use it three ways:

- **As an MCP server** for the agent you already use. Any MCP client that can send an HTTP header can list and call Core's tools.
- **As a terminal agent.** Core embeds the [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) runtime, so `thebe` gives you a TUI and a one-shot CLI that can read files, edit files and run commands in a workspace you choose.
- **Through its HTTP API.** Sessions, goals, schedules, an activity feed, approvals and the audit log, documented in OpenAPI at `/docs`.

The name comes from Thebe, a moon of Jupiter (Jupiter XIV), pronounced /ˈθiːbi/.

> **Status: pre-release.** There is no tagged version yet. The test suite and the container smoke test pass, but the service integrations (Emby, Jellyfin, Immich, Navidrome, OpenList, qBittorrent, aria2, Prowlarr, Arcane) are tested against recorded responses and mocks, not yet against every live release of each product. Claude Code, Codex and OpenCode have listed and called `/mcp` tools in real sessions, and the official MCP TypeScript SDK passes initialize, list and call. Read [SECURITY.md](SECURITY.md) before exposing Core beyond your own machine.

## What it can do

With a model and a workspace configured, the agent can read files, edit files and run commands, several steps in one task. Edits and commands ask for confirmation by default. Longer work can run as a goal, a background worker or a schedule.

With a service configured, it can also:

- Search Emby and Jellyfin by title, person or year, and read the overview and cast
- Search Immich photos by what is in the picture
- Browse Navidrome albums, artists, playlists and lyrics, and manage the play queue. Optional NetEase and SQMusic lookups, and approval-gated SQMusic downloads
- Browse and organize files and start offline downloads in OpenList, and list or control downloads in qBittorrent and aria2
- Run a download through copy, library scan and verification when OpenList, a download engine and Emby or Jellyfin are configured. With Prowlarr it can search for a release first
- Read container status and logs through Arcane, or through the Docker Engine API behind a restricted `docker-socket-proxy`. Start and restart ask for confirmation
- Call any HTTP service from an OpenAPI 3 or Swagger 2 document you provide. Which read operations are open is set in config; writes ask for confirmation
- Load skills, and connect other MCP servers from `.thebe/mcp.json`
- Search the web through a SearXNG instance you point it at (off until `THEBE_WEB_SEARCH_URL` is set); results include source links

Models, service URLs and credentials are in the [configuration guide](docs/configuration.en.md).

## Quick start

The container is the supported way to run Core; see the [deployment guide](docs/DEPLOYMENT.md). It is built for x86_64 and arm64. A workflow publishes a multi-arch image to GitHub Container Registry (`ghcr.io/unitsung/thebe-core`) when a `v*` tag is pushed. No release has been tagged yet, so build the image from this repository for now.

```bash
cd deploy
cp .env.example .env     # set THEBE_TOKEN, THEBE_ALLOWED_HOSTS, THEBE_WORKSPACE
docker compose up -d --build
TOKEN=$(sed -n 's/^THEBE_TOKEN=//p' .env)
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/health
```

From source, without Docker (Node.js 24 LTS, which bundles npm; a workspace directory is required):

```bash
npm install
cp .env.example .env
THEBE_WORKSPACE_DIR=/srv/thebe-workspace npm run start:build
```

Core does not ship a model. Sign in to a provider from the terminal UI (`/settings`) or through `GET /v1/provider`, then connect your services with the [configuration guide](docs/configuration.en.md).

## Using Core

**With your own agent (MCP).** `POST /mcp` is a stateless JSON-RPC endpoint (tools only) that exposes Core's capabilities. Send the token in an `X-Thebe-Token` header:

```bash
curl -s -X POST -H "X-Thebe-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:8787/mcp
```

Point your agent's MCP configuration at that URL with the same header. An agent connected over `/mcp` can use the write tools too (restart a container, edit a playlist, a provider's write tools). Core does not ask anyone first on that path. Each tool carries `readOnlyHint` and `destructiveHint`, and asking the user is up to the calling agent and its client. Every write is recorded in the audit log. Set `THEBE_MCP_WRITES=off` to make `/mcp` read-only.

**In the terminal.** `npm run tui` builds and starts the interactive UI. After a build, `node dist/cli.js` (or `thebe`, the package's `bin`) does the same, and `thebe -p "list my containers"` runs one prompt and exits. `thebe --help` lists the session and MCP subcommands, and `thebe doctor` reports the isolation posture.

**Over HTTP.** Every `/v1` route needs the token. The API reference is served at `/docs` (Swagger UI), with the raw spec at `/openapi.json`; neither needs a token.

```bash
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/capabilities
```

## Safety in short

The token grants full access: there are no scopes. The container listens on loopback by default; put anything wider behind TLS (Tailscale or a reverse proxy) and list the host names in `THEBE_ALLOWED_HOSTS`. The default permission mode asks before editing files or running commands, shell commands are risk-graded and run in an OS sandbox on a host, tool output and MCP data are treated as untrusted, secrets are redacted, and every call is written to an append-only audit log (`audit.jsonl` in the agent store). [SECURITY.md](SECURITY.md) has the full model and how to report a vulnerability.

## Responsible use

Core drives services you run and accounts you hold; it does not provide, host, index or recommend any content. Some optional integrations connect to downloaders, indexers (Prowlarr), cloud drives and third-party music services (SQMusic, and an unofficial NetEase API service you run yourself). Those integrations are conveniences for tools you already use.

You are responsible for what you ask Core to do with them: make sure you have the right to download, copy or store the material, and follow the laws where you live and the terms of the services you connect. The maintainers do not endorse or take responsibility for infringing use, and the software is provided as is, without warranty, under the [Apache-2.0 license](LICENSE). Downloads and other writes need your approval by default, and every call is recorded in the audit log, so you can see what ran.

## Documentation

| Topic                                     | Where                                                          |
| ----------------------------------------- | -------------------------------------------------------------- |
| Models, services, MCP, sandboxing         | [Configuration](docs/configuration.en.md)                      |
| Container, upgrade, backup, release check | [Deployment](docs/DEPLOYMENT.md)                               |
| HTTP routes                               | [Core product HTTP](docs/CORE-PRODUCT-HTTP.md)                 |
| Using a service's own MCP server          | [Provider MCP](docs/PROVIDER-MCP.md)                           |
| Changes                                   | [CHANGELOG.md](CHANGELOG.md)                                   |
| Roadmap                                   | [ROADMAP.md](ROADMAP.md)                                       |
| Vocabulary and architecture               | [CONTEXT.md](CONTEXT.md)                                       |
| Contributing and security                 | [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) |

Development checks: `npm run typecheck`, `npm run lint`, `npm run format`, `npm test`, `bash scripts/release-check.sh`.

## License

Apache-2.0. The code is licensed under Apache-2.0; the Thebe name and logo are not part of that license, and do not give you the right to publish a product under the same name.

Contributions need a `Signed-off-by` line; see [CONTRIBUTING.md](CONTRIBUTING.md).
