# Thebe Core

[简体中文](README.zh-CN.md)

Thebe Core is a server you run on your own machine. It works with the services you already run: a media library, photos, music, files, downloads, and containers. The name comes from Thebe, a moon of Jupiter (Jupiter XIV), pronounced /ˈθiːbi/.

This repository is the server, and it is optional. The Thebe app for Apple platforms is a separate, closed-source product that works with your services directly and does not need Core; Core adds what a phone app cannot do alone: an AI agent, background and scheduled jobs, approvals for risky actions, and an MCP endpoint other agents can use. The app's source is not in this repository. What you can use from here is the terminal, the HTTP API, and MCP.

> **Status: pre-release.** There is no tagged version yet. The test suite and the
> container smoke test pass, but the service integrations (Emby, Jellyfin, Immich,
> Navidrome, OpenList, qBittorrent, aria2, Prowlarr, Arcane) are tested against
> recorded responses and mocks, not yet against every live release of each product.
> Expect rough edges, and read [SECURITY.md](SECURITY.md) before exposing it beyond
> your own machine.

The server runs as one Docker container, for x86_64 and arm64: a NAS, a mini PC, a Raspberry Pi, or a cloud server. A workflow builds a multi-arch image for GitHub Container Registry (`ghcr.io/unitsung/thebe-core`) when a `v*` tag is pushed. No release has been tagged yet, so build the image from this repository for now.

## What it does

The agent runtime is pi-coding-agent. In the workspace you set, it can read files, edit files, and run commands, including several steps in one task. Edits and commands ask for confirmation by default. Longer work can run as a goal, a background worker, or a schedule.

With a service configured, it can also:

- Search Emby and Jellyfin by title, person, or year, and read the overview and cast
- Search Immich photos by what is in the picture
- Browse Navidrome albums, artists, playlists, and lyrics, and manage the play queue. Optional NetEase and SQMusic lookups, and approval-gated SQMusic downloads
- Browse and organize files and start offline downloads in OpenList, and list or control downloads in qBittorrent and aria2
- Run a download through copy, library scan, and verification when OpenList, a download engine, and Emby or Jellyfin are configured. With Prowlarr it can search for a release first
- Read container status and logs through Arcane, or through the Docker Engine API behind a restricted `docker-socket-proxy`. Start and restart ask for confirmation
- Load skills, and connect MCP servers from `.thebe/mcp.json`
- Call an HTTP service from an OpenAPI 3 or Swagger 2 document you provide. Which read operations are open is set in config; writes ask for confirmation
- Search the web through a SearXNG instance you point it at (off until `THEBE_WEB_SEARCH_URL` is set); results include source links

Models, service URLs, and credentials are in the [configuration guide](docs/configuration.en.md).

## Where Core fits

Use the app alone if you want to look at and control your services, play media, and chat with the app's own agent. Add Core when you need something a phone cannot do on its own:

| You want                                                                           | Needs Core          |
| ---------------------------------------------------------------------------------- | ------------------- |
| Downloads, library scans and schedules that keep running while your phone sleeps   | yes                 |
| An agent that runs commands or edits files on the server                           | yes                 |
| Push and approvals for risky actions                                               | yes                 |
| Your own agent (OpenClaw, Hermes, Claude Code, Codex) to use your homelab services | yes, through `/mcp` |
| Browsing services, playing media, interactive chat in the app                      | no                  |

Core is not trying to be a general-purpose agent platform or a chat gateway. If you already run one, point it at Core's `/mcp` endpoint instead of replacing it. Today `/mcp` offers read tools only; writes are refused over `/mcp` and run only in a Core session, where you approve them.

## Quick start

Build the container from this repository; see the [deployment guide](docs/DEPLOYMENT.md). Running from source, without Docker, needs Node.js 24 LTS (npm is bundled).

```bash
cd deploy
cp .env.example .env     # set THEBE_TOKEN, THEBE_ALLOWED_HOSTS, THEBE_WORKSPACE
docker compose up -d --build
TOKEN=$(sed -n 's/^THEBE_TOKEN=//p' .env)
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/health
```

From source (a workspace directory is required):

```bash
npm install
cp .env.example .env
THEBE_WORKSPACE_DIR=/srv/thebe-workspace npm run start:build
```

Then connect a model and your services with the [configuration guide](docs/configuration.en.md). Core does not ship a model: sign in to a provider from the terminal UI (`/settings`) or through `GET /v1/provider`.

## Using it without the app

There are three ways in. Each goes through the same permission and approval rules.

**Terminal.** `npm run tui` builds and starts the interactive UI. After a build, `node dist/cli.js` (or `thebe`, the package's `bin`) does the same, and `thebe -p "list my containers"` runs one prompt and exits. `thebe --help` lists the session and MCP subcommands, and `thebe doctor` reports the isolation posture.

**HTTP API.** Every `/v1` route needs the token in an `X-Thebe-Token` header. The API reference is served at `/docs` (Swagger UI) with the raw spec at `/openapi.json`; both need no token. It is the quickest way to see what Core can do and to try it:

```bash
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/capabilities
```

**MCP.** `POST /mcp` is a stateless JSON-RPC endpoint (tools only) that exposes Core's capabilities to any MCP client that can send the token header:

```bash
curl -s -X POST -H "X-Thebe-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:8787/mcp
```

Writes are refused over `/mcp`; they only run inside an agent session, where you approve them.

## Security in short

The token grants full access: there are no scopes. The container listens on loopback by default; put anything wider behind TLS (Tailscale or a reverse proxy) and list the host names in `THEBE_ALLOWED_HOSTS`. The default permission mode asks before editing files or running commands. Tool output and MCP data are treated as untrusted. [SECURITY.md](SECURITY.md) has the full model and how to report a vulnerability.

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
| Design decisions                          | [docs/adr](docs/adr)                                           |
| Changes                                   | [CHANGELOG.md](CHANGELOG.md)                                   |
| Roadmap                                   | [ROADMAP.md](ROADMAP.md)                                       |
| Vocabulary and architecture               | [CONTEXT.md](CONTEXT.md)                                       |
| Contributing and security                 | [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) |

Development checks: `npm run typecheck`, `npm run lint`, `npm run format`, `npm test`, `bash scripts/release-check.sh`.

## License

Apache-2.0. The code is licensed under Apache-2.0; the Thebe name and the Thebe app's icon and
other artwork are not part of that license, and do not give you the right to publish a product
under the same name.

Contributions need a `Signed-off-by` line; see [CONTRIBUTING.md](CONTRIBUTING.md).
