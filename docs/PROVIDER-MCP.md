# Provider MCP coverage

Which services in Thebe's target list ship their **own** MCP server, so Core can
use it instead of growing a built-in adapter. This is the concrete input to the
`ServiceCoverage` rule in `../CONTEXT.md`.

Checked 2026-10-13 against each vendor's official docs / repository and the
official MCP Registry (`registry.modelcontextprotocol.io`); the community
section adds GitHub and npm signals. "Official" means maintained by the product's
own organisation, not just published by a community member. The registry is
**not** authoritative for in-product servers: Home Assistant ships one and is not
listed there.

## Have an official MCP server

| Service        | Server                                                              | Transport                                                                                             | Attach in Core                                                                                                       | Verified                         |
| -------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Home Assistant | In-product "Model Context Protocol Server" integration (HA 2025.2+) | Streamable HTTP at `<ha>/api/mcp`; OAuth 2.0 + PKCE, or a long-lived token as `Authorization: Bearer` | `thebe mcp add homeassistant --url http://homeassistant.local:8123/api/mcp --header "Authorization: Bearer <token>"` | Vendor docs read                 |
| Grafana        | `grafana/mcp-grafana` (Apache-2.0)                                  | stdio (`uvx mcp-grafana`), Docker, Helm                                                               | `thebe mcp add grafana --command uvx --arg mcp-grafana --env GRAFANA_URL=… --env GRAFANA_SERVICE_ACCOUNT_TOKEN=…`    | Vendor repo read                 |
| Docker         | Docker MCP Catalog (300+ verified servers) + MCP Toolkit / Gateway  | Toolkit/Gateway endpoint, or catalog server images                                                    | point a client at the gateway, or add one catalog server at a time                                                   | Vendor docs read                 |
| GitHub         | `github/github-mcp-server`                                          | Remote `https://api.githubcopilot.com/mcp/` (Bearer PAT), or stdio                                    | `thebe mcp add github --url https://api.githubcopilot.com/mcp/ --header "Authorization: Bearer <pat>"`               | **Live:** header delivery proven |
| Kubernetes     | `containers/kubernetes-mcp-server` (containers org)                 | stdio / HTTP                                                                                          | `thebe mcp add k8s --command …`                                                                                      | Registry entry read              |

Out of scope for this Core's homelab focus but official nonetheless: Sentry,
Notion, Linear, Cloudflare, Stripe, Atlassian, Figma, Playwright (Microsoft),
Chrome DevTools (Google), AWS, Azure/Microsoft 365, Elasticsearch, Neo4j,
MongoDB.

TrueNAS is a partial case: `truenas/truenas-mcp` is published **from the vendor's
own GitHub org** (`truenas.com`) but is self-labelled a "Research Preview" and was
quiet as of this check — see the community section below rather than treating it
as production-ready.

## No official MCP server — community, or a Core path

Checked against the official registry (none of these publish one) and GitHub, by
stars, activity, releases, CI/tests and contributor count. Registry presence is a
weak signal only: most community servers are not listed.

| Service                                                                        | Leading community MCP (stars · last push · license · signals)                                                                                                                                                                                                                                 | Recommendation                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Radarr, Sonarr, Lidarr, Prowlarr (*arr)                                        | `aplaceforallmystuff/mcp-arr` (`mcp-arr-server`, MIT, 225★, active, CI, **~1.1k npm downloads/wk**, covers the four) · `bardesss/arr-mcp` (MIT, 79★, newer, 39 tools, Docker multi-arch, **opt-in writes with preview + confirmation + audit**, spans *arr + Jellyfin/Plex/Seerr/qBittorrent) | Attach a community server. `arr-mcp` for writes and cross-service answering ("why isn't it in the library"); `mcp-arr` if you want the popular, read-oriented one. Core keeps its own Prowlarr search + acquisition pipeline; do **not** add an *arr CRUD adapter |
| Jellyseerr / Overseerr                                                         | `jhomen368/overseerr-mcp` (MIT, 25★, CI, ~90 npm/wk) · `cyanheads/seerr-mcp-server` (Apache-2.0, small but a known MCP author, guarded requests)                                                                                                                                              | Community server, or `service_api_*` if your Seerr serves an OpenAPI document                                                                                                                                                                                     |
| Plex                                                                           | `vladimir-tutin/plex-mcp-server` (MIT, 150★, active) — but **1 contributor** · `niavasha/plex-mcp-server` (MIT, 54★, TS)                                                                                                                                                                      | Community server; note the bus-factor-1 caveat for the larger one                                                                                                                                                                                                 |
| Jellyfin                                                                       | `jaredtrent/jellyfin-mcp` (MIT, 39★, Go)                                                                                                                                                                                                                                                      | Community server, or the shipped Core Jellyfin read adapter for search/inspect                                                                                                                                                                                    |
| Immich                                                                         | `barryw/ImmichMCP` (MIT, 53★, C#, no CI)                                                                                                                                                                                                                                                      | Core already ships an Immich search adapter; add the community server only if you want photo management writes                                                                                                                                                    |
| Navidrome                                                                      | `Blakeem/Navidrome-MCP` (AGPL-3.0, 90★, 4 workflows, 5 test dirs)                                                                                                                                                                                                                             | Good signals, but Core already ships a Navidrome adapter (library/search/playlist); use the community server only for listening-pattern analysis                                                                                                                  |
| qBittorrent                                                                    | `pickpppcc/qbittorrent-mcp` (27★, no license)                                                                                                                                                                                                                                                 | Core already ships qBittorrent downloads + background tasks; not worth a third-party server                                                                                                                                                                       |
| OpenList                                                                       | `hbestm/openlist-mcp-server` (4★)                                                                                                                                                                                                                                                             | Too small; Core already ships OpenList files/transfer/tasks                                                                                                                                                                                                       |
| Proxmox                                                                        | `RekklesNA/ProxmoxMCP-Plus` (MIT, **584★**, 8 workflows, 30 releases, ~18 contributors, 0 open issues, active)                                                                                                                                                                                | Strongest infra community server; attach it. No Core adapter                                                                                                                                                                                                      |
| TrueNAS                                                                        | `truenas/truenas-mcp` — **vendor org, but self-labelled "Research Preview"** (GPL-3.0, ~3 months quiet, no tests) · `spranab/truenas-mcp` (MIT, 278 actions)                                                                                                                                  | Vendor preview or the community one; TrueNAS also exposes a JSON API for `service_api_*`                                                                                                                                                                          |
| UniFi                                                                          | `sirkirby/unifi-mcp` (MIT, **893★**, 26 workflows, ~41 contributors, very active) · `enuno/unifi-mcp-server` (Apache-2.0, "official UniFi API")                                                                                                                                               | Best community project in the set; attach it                                                                                                                                                                                                                      |
| Arcane                                                                         | Core already ships the Arcane vendor adapter (`container.*` + activity); the community `Arcane-MCP-Server` (19★) is stale                                                                                                                                                                     | Keep the Core adapter                                                                                                                                                                                                                                             |
| Pi-hole, AdGuard, Gitea, Uptime Kuma, Komodo, Beszel, Healthchecks, Technitium | Nothing notable in the registry                                                                                                                                                                                                                                                               | `service_api_*` when the service serves an OpenAPI/Swagger document; otherwise none                                                                                                                                                                               |

### Quality bar before recommending a community server

Adopt it only when it clears all of these; otherwise prefer `service_api_*` or the
already-shipped Core adapter:

- a license is present (MIT/Apache-2.0 preferred; GPL is usable over the network
  but note the terms);
- pushed within roughly the last three months, with released, versioned
  artifacts (npm / PyPI / GHCR);
- at least one CI workflow **and** tests in the tree;
- more than one contributor, unless the author is a well-known MCP maintainer;
- credentials come from env/headers (never `argv`, which leaks in process
  listings), and writes are opt-in, previewed and confirmed;
- no unexpected telemetry or outbound calls beyond the services you configured.

### When to write a Core adapter instead

Write one only when a community MCP is missing or does not clear the bar **and**
Core owns semantics the MCP boundary cannot express — the approval → execute →
verify → receipt action path, or the durable acquisition/job state machine. For
plain vendor CRUD (add a movie, list a queue), a maintained community MCP or
`service_api_*` is the smaller surface and the smaller maintenance burden. Core
never bundles third-party MCP servers; the operator installs them and attaches
them with `thebe mcp add`, and this document says which are worth trusting.

### The generic bridge already gives per-operation MCP tools

`service_api_*` is the "no per-vendor code" path, and it now covers more than one
generic tool: each read operation the operator allow-lists in `readOperations` is
exposed as its own MCP tool (`service_api.<id>.<operationId>`) with a real input
schema, on both `/mcp` and `/v1/capabilities`. Writes and header-parameter
operations stay behind `service_api_write` + runtime approval. A spec that lives
elsewhere than the API host is loaded with `openapiURL` (its auth headers are not
sent off-host).

Verified live for this stack: the real Radarr (`Radarr.Api.V3/openapi.json`,
~300 KB) and Sonarr (`Sonarr.Api.V5/openapi.json`) specs parse and enumerate
hundreds of operations through the bridge, and a real public OpenAPI service is
read end to end. So for an OpenAPI-backed service there is nothing to write — only
the spec URL and the read allow-list to configure. See
`../src/adapters/service-api/live.test.ts` (`THEBE_SERVICE_API_LIVE=1`), and
`../scripts/accept-service-api.mjs` for an HTTP acceptance you can point at your
own instance.

If the service does not serve its spec, host it elsewhere and use `openapiURL`
(Radarr example):

```bash
export THEBE_SERVICE_APIS='[{"id":"radarr","baseURL":"http://radarr.local:7878","openapiURL":"https://raw.githubusercontent.com/Radarr/Radarr/develop/src/Radarr.Api.V3/openapi.json","headersEnv":{"X-Api-Key":"RADARR_API_KEY"},"readOperations":["getMovieById"]}]'
export RADARR_API_KEY=...
```

Writes are exposed per operation only when `writeOperations` allow-lists them,
and then as a preview + `service_api.confirm` pair — never a one-call mutation.

## How this was verified

- **Client, against real servers** — `src/adapters/mcp/live.test.ts`, opt-in:
  `THEBE_MCP_LIVE=1 npx vitest run src/adapters/mcp/live.test.ts`. It connects
  through Core's own `McpConnection` to (1) the official reference stdio server
  `@modelcontextprotocol/server-everything` (`tools/list` + a tool call), (2) the
  public remote MCP `https://docs.mcp.cloudflare.com/mcp` over Streamable HTTP
  (`tools/list` + a tool call), and (3) GitHub's remote MCP to prove a configured
  `headers` map reaches the server (no header → `401 missing required
  Authorization header`; with a header → a different error).
- **CLI, end to end** — `thebe mcp add <name> --url … --header …`,
  `thebe mcp enable`, `thebe mcp list`, then `thebe mcp tools` listed the live
  Cloudflare documentation tools through Core's registry.
- **Public no-auth remote MCP servers** useful for smoke testing a deploy:
  `https://docs.mcp.cloudflare.com/mcp`, `https://mcp.deepwiki.com/mcp`,
  `https://mcp.context7.com/mcp` (Context7 also accepts an optional
  `CONTEXT7_API_KEY` header). These change over time; treat them as examples.
