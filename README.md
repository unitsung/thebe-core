# Thebe Core

[简体中文](README.zh-CN.md)

Thebe Core is a server you run on your own machine. It works with the services you already run: a media library, photos, music, files, downloads, and containers. The name comes from Thebe, a moon of Jupiter (Jupiter XIV), pronounced /ˈθiːbi/.

This repository is the server. The Thebe app for Apple platforms is not in this repository, and its source is not published. What you can use from here is the terminal, the HTTP API, and MCP.

The server runs as one Docker container, for x86_64 and arm64: a NAS, a mini PC, a Raspberry Pi, or a cloud server. No prebuilt image is published. Build it from this repository.

## What it does

The agent runtime is pi-coding-agent. In the workspace you set, it can read files, edit files, and run commands, including several steps in one task. Edits and commands ask for confirmation by default.

With a service configured, it can also:

- Search Emby and Jellyfin by title, person, or year, and read the overview and cast
- Search Immich photos by what is in the picture
- Browse Navidrome albums, artists, playlists, and lyrics, and manage the play queue
- Browse and organize files and start offline downloads in OpenList, and list or control qBittorrent downloads
- Run a download through copy, library scan, and verification when OpenList, qBittorrent, and Emby or Jellyfin are configured. With Prowlarr it can search for a release first
- Read container status and logs through Arcane. Start and restart ask for confirmation
- Load skills, and connect MCP servers from `.thebe/mcp.json`
- Call an HTTP service from an OpenAPI 3 or Swagger 2 document you provide. Which read operations are open is set in config; writes ask for confirmation
- Search the web in a session. Search stays off until you turn it on, and results include source links

Models, service URLs, and credentials are in the [configuration guide](docs/configuration.en.md).

## Quick start

No prebuilt image is published. Build the container from this repository; see the [deployment guide](docs/DEPLOYMENT.md). Running from source, without Docker, needs Node.js 22.19+ and pnpm 10+.

```bash
cd deploy
cp .env.example .env     # set THEBE_TOKEN, THEBE_ALLOWED_HOSTS, THEBE_WORKSPACE
docker compose up -d --build
TOKEN=$(sed -n 's/^THEBE_TOKEN=//p' .env)
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/health
```

From source (a workspace directory is required):

```bash
pnpm install
cp .env.example .env
THEBE_WORKSPACE_DIR=/srv/thebe-workspace pnpm start:build
```

Then connect a model and your services with the [configuration guide](docs/configuration.en.md).

## Documentation

| Topic | Where |
| --- | --- |
| Models, services, MCP, sandboxing | [Configuration](docs/configuration.en.md) |
| Container, upgrade, backup, release check | [Deployment](docs/DEPLOYMENT.md) |
| HTTP routes | [Core product HTTP](docs/CORE-PRODUCT-HTTP.md) |
| Roadmap | [ROADMAP.md](ROADMAP.md) |
| Vocabulary and architecture | [CONTEXT.md](CONTEXT.md) |
| Contributing and security | [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) |

Development checks: `pnpm typecheck`, `pnpm test`, `bash scripts/release-check.sh`.

## License

Apache-2.0
