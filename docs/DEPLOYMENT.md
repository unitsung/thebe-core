# Core deployment and operator runbook

Status: supported path for a self-hosted Thebe Core.
Shape: **one container** that runs `node dist/serve.js` against a mounted data
directory. A host service is
possible for development, but the container is the supported release shape.

> 中文速览：Core 以单个容器交付；所有持久状态在 `deploy/data`（配置、Pi agent、
> 会话元数据、输出），工作区默认挂 `./workspace` 到 `/workspace`；token 首次启动
> 自动生成并打印，本机 / 私网 / `.local` / Tailscale `.ts.net` 的 Host 自动放行；
> 对外只发布 loopback 端口，用 Tailscale Serve 或反向代理终止 TLS；需要接
> claude.ai / ChatGPT connector 时，在网关端口启用 OAuth；升级 = 换镜像
>
> - 保留 `data/`；发布前跑 `bash scripts/release-check.sh`（typecheck/build/test/smoke 一步到位）。

## 1. Quick start (container)

```bash
cd deploy
cp .env.example .env
# .env is optional; edit it only to pin THEBE_TOKEN or point THEBE_WORKSPACE elsewhere
docker compose up -d --build
docker compose ps                                   # health: starting → healthy
TOKEN=$(sed -n 's/^THEBE_TOKEN=//p' .env)           # empty if Core generated one; see the logs
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/health
```

The container publishes `127.0.0.1:8787` only, and mounts:

```text
deploy/data      → /data      config.json, Pi agent files, session metadata, outputs
$THEBE_WORKSPACE → /workspace the only tree the agent may touch
```

Everything durable lives under `/data`, so backup, upgrade, and rollback all
operate on that one directory.

### 1.1 Use the published image

A multi-arch image (`linux/amd64` and `linux/arm64`) is built and pushed to
GitHub Container Registry by `.github/workflows/publish-image.yml`, which runs
on version tags (`v*`) and manual dispatch — not on every push. The package is
private until the first public release; once it is public no login is needed.
While it is private, authenticate first with a GitHub account that has access:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin   # token needs read:packages
```

Point the compose file at it in `deploy/.env`:

```bash
THEBE_IMAGE=ghcr.io/unitsung/thebe-core:latest   # or :1.2.3, :1.2, or a sha-* tag (git tag v1.2.3 gives :1.2.3)
```

```bash
docker compose pull
docker compose up -d
```

With `THEBE_IMAGE` set and the image present locally, `docker compose up` uses the
pulled image and does not rebuild; add `--build` only to build the local source
(§2) instead. Until Core is open-sourced there is no pullable public image.

### 1.2 NAS notes

- **Architecture.** The same tag covers `linux/amd64` and `linux/arm64`, so an
  Intel/AMD NAS and an ARM NAS pull the same reference.
- **Workspace ownership.** The container runs as uid/gid 1000 (`node`), but the
  bind-mounted workspace keeps the host's ownership. On Linux,
  `chown -R 1000:1000 $THEBE_WORKSPACE` (or grant group write), or the agent
  cannot write. On macOS + colima/Docker Desktop the virtiofs mount cannot be
  chowned: use a Docker named volume for `/workspace`, or run the container as
  your host uid. `/data` is created and owned by the container on first start.
- **Mounts.** Keep both mounts on the same host. `deploy/data` is the only
  durable state — back it up (§8). Never mount the Docker socket.
- **Exposure.** Publish the port on loopback only; reach Core over Tailscale or a
  reverse proxy (§4), never directly over the LAN or internet.
- **Skills.** The image intentionally ships no built-in skills. Put them in the
  mounted workspace (`/workspace/.thebe/skills`) or a persistent `HOME`
  (`/data/home`); see the configuration guide's Skills section.

## 2. Reproducible install, build, and start

| What    | Pin                                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Node    | Node 24 LTS (package `engines`: `>=24.0.0`); the Dockerfile pins the base image to `node:24.21.0-bookworm-slim` plus its manifest-list digest |
| Install | `npm ci`; runtime images add `--omit=dev`                                                                                                     |

The release check calls the local binaries directly:

```bash
bash scripts/release-check.sh              # typecheck + lint + build + tests + smoke
bash scripts/release-check.sh --no-smoke   # typecheck + lint + build + tests only

# equivalently, by hand:
node_modules/.bin/tsc --noEmit
node_modules/.bin/oxlint
node_modules/.bin/tsdown
node_modules/.bin/vitest run
```

Start without a container (development, or a host service on a machine you
already harden). `npm start` now starts the existing build immediately; use
`npm run start:build` when source changes must be compiled first:

```bash
node_modules/.bin/tsdown            # produce dist/ first (or run the release check)
THEBE_TOKEN="$(openssl rand -hex 32)" \
THEBE_ALLOWED_HOSTS=thebe.local \
THEBE_WORKSPACE_DIR=/path/to/work \
  node dist/serve.js
```

`dist/serve.js` prints `THEBE_LISTEN <url>`, then serves. When `THEBE_TOKEN` is
unset it generates one, persists it under the config dir, and prints it once
(`THEBE_TOKEN ...`).

### 2.1 Build the container image on this host

`.github/workflows/publish-image.yml` builds and pushes the multi-arch image and
is the canonical source. To build and verify one locally — fast on a Linux host,
slower through a Docker VM on macOS — use the helper, which tags the image and
then runs the pi-ai resolution check and the smoke test inside it:

```bash
bash scripts/build-image.sh                 # tags thebe-core:local
bash scripts/build-image.sh thebe-core:dev   # custom tag
```

BuildKit is required (the Dockerfile mounts a cache); Docker 23+ and Compose v2
enable it by default. This never pushes.

## 3. Production configuration

| Variable                                                                           | Required                 | Meaning                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production`                                                              | yes                      | Enables the production token check and hardens defaults                                                                                                                                                             |
| `THEBE_TOKEN`                                                                      | no                       | Shared secret; clients send it as `X-Thebe-Token` or `Authorization: Bearer`. Generated and persisted on first start when unset, then printed once                                                                  |
| `THEBE_HOST`                                                                       | container: `0.0.0.0`     | Bind address; default `127.0.0.1`                                                                                                                                                                                   |
| `THEBE_MCP_PORT` / `THEBE_MCP_HOST`                                                | no (off)                 | A second listener for `/mcp` and, when OAuth is enabled, its public protocol endpoints (`/v1`, `/openapi.json`, `/docs` answer `404`). Expose this one, not `THEBE_PORT`; `THEBE_MCP_HOST` defaults to `THEBE_HOST` |
| `THEBE_PORT`                                                                       | no (8787)                | Bind port                                                                                                                                                                                                           |
| `THEBE_ALLOWED_HOSTS`                                                              | no                       | Extra Host-header names. Loopback, private addresses, `.local`, and Tailscale `.ts.net` names are trusted automatically; `*` accepts any Host (disables the DNS-rebinding check)                                    |
| `THEBE_WORKSPACE_DIR`                                                              | container: `/workspace`  | The only tree the agent may read/write                                                                                                                                                                              |
| `THEBE_CONFIG_DIR`, `THEBE_AGENT_DIR`, `THEBE_AGENT_STORE_DIR`, `THEBE_OUTPUT_DIR` | container: under `/data` | Durable state locations                                                                                                                                                                                             |
| `THEBE_OAUTH_ISSUER`                                                               | no (OAuth off)           | Stable public origin of the embedded authorization server, with no path. Enables OAuth; HTTPS is required except on loopback                                                                                        |
| `THEBE_MCP_RESOURCE_URL`                                                           | no (`${issuer}/mcp`)     | Public OAuth resource identifier; its path must be exactly `/mcp`, and it must use HTTPS outside loopback                                                                                                           |
| `THEBE_OAUTH_CLIENTS`, `THEBE_OAUTH_CLIENTS_FILE`                                  | until a client exists    | Inline JSON or a file of pre-registered clients. The default file is `$THEBE_CONFIG_DIR/oauth-clients.json`; a relative custom path is resolved there                                                               |
| `THEBE_OAUTH_DYNAMIC_REGISTRATION` / `THEBE_OAUTH_REGISTRATION_TOKEN`              | no                       | Dynamic Client Registration is off unless the first is true. The optional registration token becomes its initial access token                                                                                       |
| `THEBE_OAUTH_PAIRING_TTL_SECONDS`                                                  | no (300)                 | Lifetime of a one-time pairing code, constrained to 60–900 seconds                                                                                                                                                  |
| Provider credentials (`ARCANE_BASE_URL`, `ARCANE_API_KEY`, …)                      | per provider             | `deploy/.env`                                                                                                                                                                                                       |

Request contract (verified by `scripts/smoke.mjs`):

```text
/docs, /openapi.json, /swagger   readable without the token
every other route                401 without X-Thebe-Token (or Authorization: Bearer)
mutating routes                  403 when the Host header is not allowlisted
```

Secret handling:

- `deploy/.env` and `.env.local` stay out of git; `chmod 600` them.
- The image never bakes credentials in; pass them as environment variables or a
  mounted env file.
- Credential PUT/POST routes must never be reachable unauthenticated over
  plaintext LAN/public traffic. Keep the published port on loopback and use one
  of the TLS paths below.

### 3.1 Push notifications: registration here, delivery by a relay

Core stores push device registrations (`GET/POST /v1/devices`, `DELETE
/v1/devices/{registrationId}`) with a redacted token. Core holds **no** APNs
credentials. Delivery is optional and goes through a separately deployed Push
Relay (`relay/` in this repository), so a self-hosted Core never embeds Thebe's
APNs key.

Set `THEBE_PUSH_RELAY_URL` to the relay's HTTPS address to turn it on. Core then
creates an Ed25519 signing key next to its device state (`push-signing-key.pem`,
owner-only), publishes the public half at `GET /v1/push/identity`, and sends a
signed, minimal event (a generic line, a category and a `thebe://` deep link) for
each approval that starts waiting. A device registers its APNs token with the relay
using that public key, and the relay delivers only events signed by it. Unset, Core
sends nothing and behaves as before. A relay that is down never fails a request.

Notices go through a durable outbox kept next to the device state
(`push-outbox.json`), so none is lost when the relay is down or Core restarts.
The notices for one Ticket to one device are sent in order, one at a time, each
with a signed sequence number (`seq`) and the Ticket id the client can sort by.
If the relay cannot be reached, the head notice is retried with back-off from 5
to 300 seconds and the ones behind it wait; nothing is given up on while the
relay is unreachable. If the relay answers with a transient error (usually APNs
refused the notice), the head is recorded as dropped after three attempts and
the queue moves on. A permanent refusal (bad signature, unknown device,
malformed event) drops it at once. The reason for each drop is recorded and
`GET /v1/health` shows `push.pending`, `push.consecutiveFailures`,
`push.dropped`, and the latest failure or drop.

A retry keeps the notice's id. The relay remembers successfully delivered ids
for 24 hours across its own restarts and passes the id to APNs as the collapse
id, so a device shows the notice once. Upgrade the relay before Core: event
signatures are now `thebe-push-v2` and sign `ticket` and `seq` as well as the
visible message. Keep the relay's `RELAY_DATA_DIR` across upgrades so its
`registrations.json` and `seen.json` survive.

### 3.2 Background Sources, Eval, and the Goal Watchdog

Sources are off unless `THEBE_SOURCES` names them. Use a comma-separated list;
`THEBE_SOURCE_INTERVAL_MS` sets the poll interval (default 30000, minimum 1000):

```bash
export THEBE_SOURCES=container-health,download-completed
```

`container-health` emits container state Triggers and emits
`container.unhealthy` when a running container's Docker healthcheck starts
failing; it emits `container.recovered` when that healthcheck returns to healthy.
`download-completed` requires the same download provider configuration as the
media pipeline, establishes a baseline on its first read, and emits
`download.completed` when a download moves into `completed`. If any engine in a
multi-engine listing is unreachable, Core does not advance that Source's cursor.
A requested download Source with no provider configured stays visible as failing
rather than being omitted.

`GET /v1/health` reports `capabilities: [..., "sources"]` and a `sources` array
while Sources are enabled. Each entry has `state` (`starting`, `healthy`, or
`failing`), `consecutiveFailures`, and the latest timestamps/error. Alert on a
Source that remains `failing`; one failed read is retried on the next interval.
The core process remains live and other Sources continue to run.

Eval uses `THEBE_EVAL_MAX_PER_HOUR` (default 60, `0` for no limit) for its model
questions. Provider failures, unusable replies, and the hourly limit are kept as
`Decision.outcome: "unavailable"` rather than a silent no. Core sends one
Activity push for an assessment outage and does not send another until a later
assessment succeeds.

The Watchdog is configured in `config.json`; every value is milliseconds:

```json
{
  "watchdog": {
    "intervalMs": 60000,
    "goalFirstMs": 1800000,
    "goalSecondMs": 3600000,
    "workerFirstMs": 600000,
    "workerSecondMs": 600000
  }
}
```

Defaults give a Goal one read-only status check after 30 minutes without semantic
progress and pause it into `person / stalled` after 60. An inactive worker or
reviewer is cancelled and retried once after 10 minutes; another 10 minutes
without activity pauses the Goal. Every intervention writes an audit method
under `watchdog.*`, and the latest state survives on the Goal as `watchdog`.
These actions never expand its Mandate or inject work into a running worker.

## 4. Network exposure and client connections

Pick one TLS path; all three keep Core on loopback and never expose the token in
plaintext off-host:

```bash
# a) Tailscale Serve (recommended for a personal tailnet)
tailscale serve --bg --https=443 http://127.0.0.1:8787
#    → https://<machine>.<tailnet>.ts.net   ; .ts.net names are trusted automatically

# b) Tailscale Funnel (public HTTPS; still token-gated) — only if you need it
tailscale funnel --bg 443 http://127.0.0.1:8787

# c) Reverse proxy on the host (nginx/Caddy) terminating TLS
#    proxy_pass http://127.0.0.1:8787;  add the public name to THEBE_ALLOWED_HOSTS
```

Concrete reverse-proxy configs (both must preserve the `Host` header, and neither
may buffer the stream, or SSE log endpoints break):

`/etc/caddy/Caddyfile`:

```caddyfile
thebe.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name thebe.example.com;
    ssl_certificate     /etc/ssl/thebe.crt;
    ssl_certificate_key /etc/ssl/thebe.key;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;              # required: Core checks the Host header
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;                      # keep SSE streams live
        proxy_read_timeout 3600s;
    }
}
```

Rules:

- Loopback, private-network addresses, `.local`, and `.ts.net` host names are
  trusted automatically; only a public reverse-proxy name must be added.
  `THEBE_ALLOWED_HOSTS=*` accepts any Host, but disables the DNS-rebinding Host
  check (the shared token is still required). Otherwise mutating requests from
  an unlisted public Host get `403`.
- Do not publish `8787` on `0.0.0.0`, and do not put Core behind a proxy that
  strips the `Host` header.
- Clients: point them at the TLS endpoint and give them `THEBE_TOKEN` in an
  `X-Thebe-Token` header. Confirm `GET /v1/health` succeeds and `/docs` opens,
  then `GET /v1/activity` with the token.

### 4.1 Home network mode (no TLS)

Private-network hosts are trusted automatically and a client can use a plain `http://` address, so a
Core used only inside the home needs no certificate. Publish the port on the host's LAN address
only: set `THEBE_BIND=<LAN address>` in `deploy/.env` and `docker compose up -d`. Then point
clients at `http://<LAN address>:8787` with the token.

What this costs: the token crosses your network in plaintext, so anyone on it who captures a request
holds full access. Keep `THEBE_REMOTE_BASH` off and consider `THEBE_MCP_WRITES=off` unless you trust the network, never bind `0.0.0.0`,
and do not forward the port from your router. Use a TLS path above for anything beyond the home.

### 4.1.1 Gateway port for an agent on the internet

`deploy/docker-compose.yml` already maps host port 8788 (on loopback unless `THEBE_MCP_BIND` says otherwise), but
nothing listens on it until you set `THEBE_MCP_PORT=8788` in `deploy/.env`. The listener serves `/mcp`; when
OAuth is enabled it also serves the OAuth discovery, authorization, token, revocation, registration, and
interaction endpoints needed by a connector. A tunnel or reverse proxy pointed at it still cannot reach
`/v1`, `/openapi.json`, or `/docs`. Give each bearer-token agent its own scoped token (below) and watch
`GET /v1/audit?identity=<name>`.

### 4.1.2 OAuth for claude.ai and ChatGPT connectors

OAuth is off unless a stable public issuer is configured. Use the gateway with a trusted HTTPS certificate;
the issuer must be the exact public origin the connector reaches, without a path. `localhost` may use HTTP
for development.

```dotenv
THEBE_MCP_PORT=8788
THEBE_OAUTH_ISSUER=https://thebe.example.com
THEBE_MCP_RESOURCE_URL=https://thebe.example.com/mcp
```

`THEBE_MCP_RESOURCE_URL` is optional when it is the issuer followed by `/mcp`, but setting it explicitly makes
the resource contract visible. Do not point it at `/v1` or another path.

Pre-register each client in `$THEBE_CONFIG_DIR/oauth-clients.json`. In the container this is
`/data/config/oauth-clients.json`; keep it private and back it up with the rest of `/data`:

```json
{
  "clients": [
    {
      "clientId": "home-connector",
      "clientName": "Claude connector",
      "redirectUris": ["https://client.example/callback"],
      "scopes": ["mcp:read", "offline_access"]
    }
  ]
}
```

Use the exact redirect URI supplied by the connector. `clientSecret` is optional; when present Core uses
`client_secret_basic`, and without it the client is public and relies on PKCE. `scopes` defaults to
`["mcp:read", "offline_access"]`. Supported scopes are `mcp:read`, `mcp:write`, `mcp:irreversible`, and
`offline_access`. The authorization page can narrow the requested MCP scopes but cannot grant a scope that
the registered client does not contain.

The alternative variables are `THEBE_OAUTH_CLIENTS` (inline JSON using the same shape) and
`THEBE_OAUTH_CLIENTS_FILE` (a path, relative to the config directory unless absolute). If no client exists,
Core refuses to start instead of leaving a half-configured authorization server. Dynamic registration is
disabled by default. To enable it only when a connector cannot accept manual registration:

```dotenv
THEBE_OAUTH_DYNAMIC_REGISTRATION=true
THEBE_OAUTH_REGISTRATION_TOKEN=replace-with-a-long-random-value
```

When set, `THEBE_OAUTH_REGISTRATION_TOKEN` is required by `/oauth/register` as the initial access token.
Enabling dynamic registration without one lets anyone who reaches `/oauth/register` create a client, so use
it only behind deliberate network access controls.

Start the connector login with the shared/App token, then enter the returned one-time code on Core's
authorization page:

```bash
curl -fsS -X POST \
  -H "X-Thebe-Token: $THEBE_TOKEN" \
  http://127.0.0.1:8787/v1/oauth/pairing-code
```

The response contains `code` and `expiresAt`; the default lifetime is five minutes and the code works once.
The pairing API is available on the main App/API listener only. A scoped `/mcp` token gets
`403 token_scope`. A local TUI can issue the same code with `/pair` (aliases `/oauth` and `/connector`);
the App can also use the endpoint above.

The connector flow is Authorization Code + PKCE. Redirect URIs match exactly, the only accepted resource is
the configured `/mcp` URL, and access tokens are audience-bound PS256 JWTs valid for 15 minutes.
`offline_access` with `prompt=consent` yields a 30-day rotating refresh token/grant. A client can revoke its
refresh token at `/oauth/revoke`; revocation also invalidates the related access token on the next request.
The token endpoint is rate-limited, and the pairing interaction limits repeated attempts by request and by
remote address.

The App can inspect and revoke every connector grant from the main API listener with its full-access token:

```bash
curl -fsS -H "X-Thebe-Token: $THEBE_TOKEN" \
  http://127.0.0.1:8787/v1/oauth/connections
curl -fsS -X DELETE -H "X-Thebe-Token: $THEBE_TOKEN" \
  http://127.0.0.1:8787/v1/oauth/connections/GRANT_ID
```

The list reports the client name, scopes, timestamps, and whether a refresh token exists. Revocation removes
the grant and invalidates its access tokens, refresh tokens, and unredeemed authorization codes immediately.
That connector must authorize again. These management routes require the full-access token, refuse a scoped
`/mcp` token with `403 token_scope`, and remain unavailable through the internet-facing MCP port.
The local TUI provides the same management with `/connections` (alias `/grants`) and
`/connections revoke <grantId>`.

Core stores signing keys, provider state, and pairing-code hashes in `oauth-keys.json`, `oauth-state.json`,
and `oauth-pairing.json` under the config directory (modes `0600`). The key file is bound to the issuer.
Changing `THEBE_OAUTH_ISSUER` against an existing key file makes startup fail; choose the final issuer before
connecting clients and do not edit or rotate these files by hand.

### 4.2 Managing tokens

Give each device its own token, so a lost phone costs one `revoke`, not a new token on every device:

```bash
docker compose exec thebe-core node dist/token.js create "My iPhone"   # shown once; only a hash is kept
docker compose exec thebe-core node dist/token.js list                 # name, created, last used
docker compose exec thebe-core node dist/token.js revoke "My iPhone"   # that device only
```

An agent that connects over `/mcp` should have its own token, limited to `/mcp`:

```bash
docker compose exec thebe-core node dist/token.js create "Claude Code" --scope mcp:read    # read tools only
docker compose exec thebe-core node dist/token.js create "Home agent" --scope mcp:write    # read and write tools
docker compose exec thebe-core node dist/token.js create "Cleaner" --scope mcp:irreversible    # also deletes that cannot be undone
```

The agent sends it as `Authorization: Bearer <token>` (or `X-Thebe-Token`). A scoped token is refused
everywhere except `/mcp` (`403 token_scope`), so it cannot open a session, change settings or run an
action. A write tool called with a read-only token fails at once and says which scope to grant;
nothing waits for approval. `mcp:write` still obeys `THEBE_MCP_WRITES=off`.

Every `/mcp` call is audited under the token's name: `GET /v1/audit?identity=Claude%20Code` lists what that agent
did and what it was refused (`result: "denied"`). A scoped token may make 120 calls a minute; past that a call fails
at once with `429 rate_limited` (`THEBE_MCP_RATE_LIMIT` changes it, `0` turns it off). To put the gateway on the
internet, set `THEBE_MCP_PORT=8788` and expose only that port (Tailscale Funnel, a tunnel or a reverse proxy):
it serves `/mcp` and, when configured, the OAuth protocol endpoints, while `/v1`, `/openapi.json` and
`/docs` cannot be reached through it.

A delete that cannot be undone needs `mcp:irreversible`, judged per call: `download_delete` with
`deleteFiles: true`, `navidrome_playlist_delete`, a service API call that sends an HTTP `DELETE` or sets a
delete-style flag such as `deleteFiles` or `purge`, and a provider tool its server marks destructive. A
`mcp:write` token is refused these at once (`403 mcp_irreversible_required`) with the command that grants the
scope. A token made without `--scope` keeps full access.

The shared token Core made on first start (or `THEBE_TOKEN`) keeps working next to the device tokens:

```bash
docker compose exec thebe-core node dist/token.js status   # where it comes from, when it changed
docker compose exec thebe-core node dist/token.js show     # print it
docker compose exec thebe-core node dist/token.js rotate   # replace it; the old one stops at once
docker compose exec thebe-core node dist/token.js revoke --all   # every device token, and close the shared one
```

Outside a container: `npm run token -- <command>` with the same `THEBE_CONFIG_DIR` as the running Core.
Device tokens live hashed in `{config}/tokens.json` (mode 0600) with last-use times in
`token-usage.json`; the server re-reads them as they change, so every command applies at once, with no
restart. If nothing is configured, nothing is accepted. A token set through `THEBE_TOKEN` belongs to
your environment: `rotate` and `revoke --all` leave it alone. A token made without `--scope`, the
shared token and `THEBE_TOKEN` have full access.

## 5. Process isolation boundary

Core and its Pi runtime do **not** provide an OS sandbox by themselves. The
container is the release boundary:

- `read_only: true` root filesystem, `cap_drop: ALL`,
  `no-new-privileges:true`, `/tmp` on tmpfs.
- Only `/data` and `/workspace` are writable; `/workspace` is the single
  authorization boundary (`THEBE_WORKSPACE_DIR`).
- Leave `THEBE_SANDBOX` unset in the container. Core sees `/.dockerenv` or
  `/run/.containerenv` and does not start a second sandbox. A host install
  uses the OS sandbox by default; `THEBE_SANDBOX=off` is the only escape
  hatch. See `docs/configuration.en.md`.
- `THEBE_FULL_ACCESS` is ignored. It does not start Core in bypass. Turn
  bypass on in the TUI or a graphical client; both ask first. That choice is the host
  default when saved from settings, so schedules and subagents follow it.
- Choosing the host-service path instead means you provide the dedicated user
  (no login shell, no sudo) and the filesystem permissions yourself.

Check what is actually in effect, on the host or in the container:

```bash
thebe doctor                              # the CLI prints the same report offline
# or, against a running deployment:
curl -s -H "X-Thebe-Token: $THEBE_TOKEN" http://127.0.0.1:8787/v1/system/isolation
```

The report shows `sandbox.mode` (`off` or `os`) and whether it is **enforced**.
Inside the container the mode stays `off` when the variable is unset. On a host,
`os` is enforced only when the sandbox dependencies are present; if they are
missing, bash commands are refused and `thebe doctor` exits 1. There is no
silent unsandboxed run. `warnings` lists relaxed layers (`THEBE_ALLOWED_HOSTS=*`),
and Core prints each as a `SECURITY:` line at startup. `thebe doctor` also exits
non-zero when the workspace is missing. A leftover `THEBE_SANDBOX` value other
than `off` is ignored.

## 6. Health check and graceful shutdown

- Liveness: `GET /v1/health` with `X-Thebe-Token`. The compose healthcheck and
  the Dockerfile `HEALTHCHECK` poll it every 30s (30s start period).
- Readiness for clients: `GET /v1/system/status` once a token is configured.
- Shutdown: `SIGTERM` drains — the HTTP server stops accepting, in-flight
  requests finish, the agent quiesces, then the process exits `0`. A force-exit
  after 8s guards a stuck runtime, so allow ~10s in `docker stop -t 15`.

```bash
docker compose stop -t 15      # graceful
docker compose logs --tail=50 thebe-core
```

## 7. Upgrade and rollback

```bash
# 1. back up (§8) and note the running image tag
docker compose images

# 2. build/pull the new tag, then recreate
docker compose build && docker compose up -d

# 3. verify
docker compose ps                                    # healthy
node scripts/smoke.mjs --base-url http://127.0.0.1:8787 --token "$THEBE_TOKEN"

# 4. rollback = previous image tag against the same /data
docker compose down
docker run ... thebe-core:<previous-tag>
```

Upgrades keep `/data`. The store is additive and readers ignore unknown fields
and unreadable snapshots, so an older bundle tolerates newer files for the
current store set. Before a production upgrade, keep a `/data` copy so rollback
can restore the directory, not just the image.

## 8. Backup and restore

Everything durable is under `/data`:

```bash
# backup (stop the container so the store is quiescent)
docker compose stop -t 15
tar -czf thebe-core-$(date +%Y%m%d).tgz -C deploy data
docker compose start

# restore (same layout; keep the container stopped while replacing)
docker compose down
mv deploy/data deploy/data.broken
tar -xzf thebe-core-YYYYMMDD.tgz -C deploy      # recreates deploy/data
docker compose up -d
```

The archive contains `config.json`, Pi agent credentials under `data/agent`,
session metadata, and when OAuth is enabled `data/config/oauth-keys.json`,
`oauth-state.json`, and `oauth-pairing.json`, so treat it as a secret
(`chmod 600`). Restoring without the agent directory would silently log the
agent out. Restoring OAuth state without its matching issuer preserves existing
clients and grants; restoring only the key file can make every persisted grant
unreadable, so keep the OAuth files together.

## 9. Data-directory compatibility policy

- The supported upgrade unit is the container image plus its `/data` directory.
  Store files are JSON/JSONL written atomically.
- Reads tolerate unknown fields and skip unreadable snapshots, so a new image
  reads an older `/data` without a migration step at this stage.
- Terminal capability runs, Goals, and Workers survive recreation as
  `restored`; work that was active when the previous instance stopped is
  reported as `interrupted` and is never silently replayed.
- If a future release changes a store layout, it must ship a migration note here
  and a version check. Until then, "keep `/data`, swap the image" is the whole
  policy — with a backup first.

## 10. Release smoke test and the release gate

`scripts/smoke.mjs` is the operator-verifiable smoke test. Default mode spawns
`dist/serve.js` on a free port with a throwaway data directory and checks
health, token auth, the Host allowlist, a settings write, graceful SIGTERM, and
that the setting survives a restart:

```bash
node scripts/smoke.mjs                                    # local, spawns Core
node scripts/smoke.mjs --base-url https://… --token "$THEBE_TOKEN"   # existing deployment
node scripts/smoke.mjs --keep                             # keep the temp data dir
docker compose run --rm thebe-core node scripts/smoke.mjs # inside the image
```

Expected output ends with `SMOKE OK (8 checks)`.

Release gate:

```bash
bash scripts/release-check.sh     # tsc --noEmit + oxlint + tsdown + vitest run + smoke
```

GitHub Actions does not run this gate on every push.
`.github/workflows/verify.yml` is manual `workflow_dispatch`, and image
publishing runs only on version tags.

### Local verification gate

Routine changes reach `dev` through the local `thebe/local-verify` delivery gate
instead of GitHub Actions on every push:

1. On the NAS, the gate installs from the lockfile with `npm ci` and runs
   `bash scripts/release-check.sh` — typecheck, lint, build, the full Vitest
   suite, and the smoke test.
2. An independent reviewer that does not share the worker's transcript checks
   the diff against the acceptance criteria and the verifier output.
3. After that review passes, the change is squash-merged into `dev`
   automatically as one conventional commit.

A failed check or review blocks the merge; fix the root cause and rerun the
gate. The same `scripts/release-check.sh` command is the release gate above, so
a local pass and a manual `verify` dispatch run the same checks.

### Container verification after an upgrade

```bash
docker compose exec thebe-core node scripts/check-pi-resolution.mjs
```

It must print `pi-ai OK …`. `MISSING` means the production install lost the
nested `@earendil-works/pi-ai` copy; reinstall with `npm ci --omit=dev`.

## 11. Troubleshooting

| Symptom                                                  | Cause                                                                     | Fix                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `401` on every route                                     | Missing/incorrect `X-Thebe-Token`                                         | Send the token from `deploy/.env`; `/docs` is the only token-free route                                                                   |
| `403` with `token_scope` on a route other than `/mcp`    | The token was made with `--scope`, which limits it to `/mcp`              | Use a token made without `--scope` for `/v1`; keep scoped tokens for agents on `/mcp`                                                     |
| `403` on writes, reads fine                              | `Host` header not in the allowlist and not a local/private name           | Add the client's host name to `THEBE_ALLOWED_HOSTS` and restart. Loopback, private IPs, `.local`, and `.ts.net` are trusted automatically |
| Client needs the token                                   | First start generated one                                                 | Read it from the startup logs (`THEBE_TOKEN ...`) or `deploy/data/config/token`                                                           |
| `docker build` fails with `--mount requires BuildKit`    | Legacy (pre-BuildKit) builder                                             | Use Docker 23+/Compose v2, or `DOCKER_BUILDKIT=1 docker build`                                                                            |
| `Could not find @earendil-works/pi-ai dist`              | Pruned install lost the nested copy                                       | Reinstall with `npm ci --omit=dev`; verify with `scripts/check-pi-resolution.mjs`                                                         |
| Agent cannot write files                                 | `/workspace` not writable by uid 1000                                     | `chown 1000:1000` the host folder, or grant group write                                                                                   |
| OAuth startup says no pre-registered client              | Issuer is set without clients and DCR is off                              | Create `$THEBE_CONFIG_DIR/oauth-clients.json`, set `THEBE_OAUTH_CLIENTS`, or deliberately enable DCR                                      |
| OAuth rejects the issuer or redirect URI                 | Public URLs need HTTPS, the issuer needs no path, redirects match exactly | Use the connector's exact callback and a stable HTTPS origin; HTTP is accepted only on loopback                                           |
| Connector shows the authorization page but no code works | Pairing codes are one-time and expire                                     | Issue a new code from the main listener and enter it before `expiresAt`                                                                   |

## 12. What has been verified on this checkout

- Local gates pass on macOS with Node 24 and the `npm` install: `tsc --noEmit`,
  `oxlint`, `tsdown` (bundling four Node ESM entries into `dist/`), the full
  Vitest suite, and `scripts/smoke.mjs` (8/8 checks,
  including SIGTERM exit `0` and a settings write surviving a Core restart).
- `scripts/check-pi-resolution.mjs` resolves pi-ai in the current install.
- OAuth directional tests pass locally, including PKCE, scope narrowing, JWT
  issuer/audience checks, restart persistence, and immediate invalidation after
  refresh-token revocation. No real claude.ai or ChatGPT connector/device
  acceptance run has been completed on this checkout.
- The container builds and runs. The optimized image (490 MB on disk, 104 MB
  compressed; ~30% smaller than a plain `npm ci --omit=dev` image) passes
  `scripts/check-pi-resolution.mjs` and `scripts/smoke.mjs` (8/8) inside the
  running container.
- The handwritten Seatbelt, bubblewrap, disposable-Docker and Gondolin checks
  are gone. Host bash isolation is `@anthropic-ai/sandbox-runtime`.
  The container still does not nest that sandbox.
