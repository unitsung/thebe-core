# Core deployment and operator runbook

Status: supported path for a self-hosted Thebe Core.
Shape: **one container** that runs `node dist/serve.js` against a mounted data
directory. A host service is
possible for development, but the container is the supported release shape.

> 中文速览：Core 以单个容器交付；所有持久状态在 `deploy/data`（配置、Pi agent、
> 会话元数据、输出），工作区默认挂 `./workspace` 到 `/workspace`；token 首次启动
> 自动生成并打印，本机 / 私网 / `.local` / Tailscale `.ts.net` 的 Host 自动放行；
> 对外只发布 loopback 端口，用 Tailscale Serve 或反向代理终止 TLS；升级 = 换镜像
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
THEBE_IMAGE=ghcr.io/unitsung/thebe-core:latest   # or :v1.2.3, :1.2, or a sha-* tag
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

| Variable                                                                           | Required                 | Meaning                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production`                                                              | yes                      | Enables the production token check and hardens defaults                                                                                                                          |
| `THEBE_TOKEN`                                                                      | no                       | Shared secret; clients send it as `X-Thebe-Token`. Generated and persisted on first start when unset, then printed once                                                          |
| `THEBE_HOST`                                                                       | container: `0.0.0.0`     | Bind address; default `127.0.0.1`                                                                                                                                                |
| `THEBE_PORT`                                                                       | no (8787)                | Bind port                                                                                                                                                                        |
| `THEBE_ALLOWED_HOSTS`                                                              | no                       | Extra Host-header names. Loopback, private addresses, `.local`, and Tailscale `.ts.net` names are trusted automatically; `*` accepts any Host (disables the DNS-rebinding check) |
| `THEBE_WORKSPACE_DIR`                                                              | container: `/workspace`  | The only tree the agent may read/write                                                                                                                                           |
| `THEBE_CONFIG_DIR`, `THEBE_AGENT_DIR`, `THEBE_AGENT_STORE_DIR`, `THEBE_OUTPUT_DIR` | container: under `/data` | Durable state locations                                                                                                                                                          |
| Provider credentials (`ARCANE_BASE_URL`, `ARCANE_API_KEY`, …)                      | per provider             | `deploy/.env`                                                                                                                                                                    |

Request contract (verified by `scripts/smoke.mjs`):

```text
/docs, /openapi.json, /swagger   readable without the token
every other route                401 without X-Thebe-Token
mutating routes                  403 when the Host header is not allowlisted
```

Secret handling:

- `deploy/.env` and `.env.local` stay out of git; `chmod 600` them.
- The image never bakes credentials in; pass them as environment variables or a
  mounted env file.
- Credential PUT/POST routes must never be reachable unauthenticated over
  plaintext LAN/public traffic. Keep the published port on loopback and use one
  of the TLS paths below.

### 3.1 Push notifications: registration here, delivery elsewhere

Core stores push device registrations (`GET/POST /v1/devices`, `DELETE
/v1/devices/{registrationId}`) with a redacted token, and clients register
notification categories. Core does **not** deliver push notifications and this
release ships no relay: remote notifications are not delivered. When delivery is
added it arrives as a separately deployed Push Relay that Core signs events for,
so a self-hosted Core never embeds Thebe's APNs credentials. Until then, do not
run or document a relay as part of this deployment.

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

### 4.2 Managing tokens

Give each device its own token, so a lost phone costs one `revoke`, not a new token on every device:

```bash
docker compose exec thebe-core node dist/token.js create "My iPhone"   # shown once; only a hash is kept
docker compose exec thebe-core node dist/token.js list                 # name, created, last used
docker compose exec thebe-core node dist/token.js revoke "My iPhone"   # that device only
```

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
your environment: `rotate` and `revoke --all` leave it alone. Tokens carry no scopes: every token has
the same access.

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

The archive contains `config.json`, Pi agent credentials under `data/agent`, and
session metadata, so treat it as a secret (`chmod 600`). Restoring without the
agent directory would silently log the agent out.

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

CI runs the same gate (`.github/workflows/verify.yml`) on every push and
pull request, so a release candidate on a clean host reproduces what CI saw.

### Container verification after an upgrade

```bash
docker compose exec thebe-core node scripts/check-pi-resolution.mjs
```

It must print `pi-ai OK …`. `MISSING` means the production install lost the
nested `@earendil-works/pi-ai` copy; reinstall with `npm ci --omit=dev`.

## 11. Troubleshooting

| Symptom                                               | Cause                                                           | Fix                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `401` on every route                                  | Missing/incorrect `X-Thebe-Token`                               | Send the token from `deploy/.env`; `/docs` is the only token-free route                                                                   |
| `403` on writes, reads fine                           | `Host` header not in the allowlist and not a local/private name | Add the client's host name to `THEBE_ALLOWED_HOSTS` and restart. Loopback, private IPs, `.local`, and `.ts.net` are trusted automatically |
| Client needs the token                                | First start generated one                                       | Read it from the startup logs (`THEBE_TOKEN ...`) or `deploy/data/config/token`                                                           |
| `docker build` fails with `--mount requires BuildKit` | Legacy (pre-BuildKit) builder                                   | Use Docker 23+/Compose v2, or `DOCKER_BUILDKIT=1 docker build`                                                                            |
| `Could not find @earendil-works/pi-ai dist`           | Pruned install lost the nested copy                             | Reinstall with `npm ci --omit=dev`; verify with `scripts/check-pi-resolution.mjs`                                                         |
| Agent cannot write files                              | `/workspace` not writable by uid 1000                           | `chown 1000:1000` the host folder, or grant group write                                                                                   |

## 12. What has been verified on this checkout

- Local gates pass on macOS with Node 24 and the `npm` install: `tsc --noEmit`,
  `oxlint`, `tsdown` (bundling four Node ESM entries into `dist/`), the full
  Vitest suite, and `scripts/smoke.mjs` (8/8 checks,
  including SIGTERM exit `0` and a settings write surviving a Core restart).
- `scripts/check-pi-resolution.mjs` resolves pi-ai in the current install.
- The container builds and runs. The optimized image (490 MB on disk, 104 MB
  compressed; ~30% smaller than a plain `npm ci --omit=dev` image) passes
  `scripts/check-pi-resolution.mjs` and `scripts/smoke.mjs` (8/8) inside the
  running container.
- The handwritten Seatbelt, bubblewrap, disposable-Docker and Gondolin checks
  are gone. Host bash isolation is `@anthropic-ai/sandbox-runtime`.
  The container still does not nest that sandbox.
