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
- A single-container deployment. Build the image from this repository. Durable state stays in `/data`.
