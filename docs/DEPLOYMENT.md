# Core deployment and operator runbook

Status: supported path for a self-hosted Thebe Core (thebe-core issue #5).
Shape: **one container** that runs `node dist/serve.js` against a mounted data
directory (see `docs/adr/0002-core-ships-as-a-container.md`). A host service is
possible for development, but the container is the supported release shape.

> 中文速览：Core 以单个容器交付；所有持久状态在 `deploy/data`（配置、Pi agent、
> 会话元数据、输出），工作区用 `THEBE_WORKSPACE` 挂到 `/workspace`；必须设置
> `THEBE_TOKEN` 与 `THEBE_ALLOWED_HOSTS`；对外只发布 loopback 端口，用 Tailscale
> Serve 或反向代理终止 TLS；升级 = 换镜像 + 保留 `data/`；发布前跑
> `bash scripts/release-check.sh`（typecheck/build/test/smoke 一步到位）。

## 1. Quick start (container)

```bash
cd deploy
cp .env.example .env
# edit .env: THEBE_TOKEN ($(openssl rand -hex 32)), THEBE_ALLOWED_HOSTS, THEBE_WORKSPACE
docker compose up -d --build
docker compose ps                                   # health: starting → healthy
TOKEN=$(sed -n 's/^THEBE_TOKEN=//p' .env)
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/health
```

The container publishes `127.0.0.1:8787` only, and mounts:

```text
deploy/data      → /data      config.json, Pi agent files, session metadata, outputs
$THEBE_WORKSPACE → /workspace the only tree the agent may touch
```

Everything durable lives under `/data`, so backup, upgrade, and rollback all
operate on that one directory.

## 2. Reproducible install, build, and start

| What | Pin |
| --- | --- |
| Node | `22.20.0` (package `engines`: `>=22.19.0`); the Dockerfile pins `node:22.20.0-bookworm-slim` |
| pnpm | `11.25.0` (`packageManager`, activated with `corepack prepare pnpm@11.25.0`) |
| Install | `pnpm install --frozen-lockfile`; runtime images add `--prod` |

`pnpm --version` / `pnpm typecheck` can hang in some release environments
(issue #5, P1). The release check therefore calls the local binaries directly:

```bash
bash scripts/release-check.sh              # typecheck + build + tests + smoke
bash scripts/release-check.sh --no-smoke   # typecheck + build + tests only

# equivalently, by hand:
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build
node_modules/.bin/vitest run
```

Start without a container (development, or a host service on a machine you
already harden):

```bash
node_modules/.bin/vite build        # produce dist/ first (or run the release check)
THEBE_TOKEN="$(openssl rand -hex 32)" \
THEBE_ALLOWED_HOSTS=thebe.local \
THEBE_WORKSPACE_DIR=/path/to/work \
  node dist/serve.js
```

`dist/serve.js` prints `THEBE_LISTEN <url>`, then serves. It refuses to start
when `NODE_ENV=production` without `THEBE_TOKEN`.

## 3. Production configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `NODE_ENV=production` | yes | Enables the production token check and hardens defaults |
| `THEBE_TOKEN` | yes | Shared secret; clients send it as `X-Thebe-Token` |
| `THEBE_HOST` | container: `0.0.0.0` | Bind address; default `127.0.0.1` |
| `THEBE_PORT` | no (8787) | Bind port |
| `THEBE_ALLOWED_HOSTS` | wildcard binds: yes | Comma list for the Host allowlist; loopback is implicit |
| `THEBE_WORKSPACE_DIR` | yes | The only tree the agent may read/write |
| `THEBE_CONFIG_DIR`, `THEBE_AGENT_DIR`, `THEBE_AGENT_STORE_DIR`, `THEBE_OUTPUT_DIR` | container: under `/data` | Durable state locations |
| Provider credentials (`ARCANE_BASE_URL`, `ARCANE_API_KEY`, …) | per provider | `deploy/.env`, or the App's provider settings |

Request contract (verified by `scripts/smoke.mjs`):

```text
/docs, /openapi.json, /swagger   readable without the token (the App links here)
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

Core stores iOS device registrations (`GET/POST /v1/devices`, `DELETE
/v1/devices/{registrationId}`) with a redacted token, and the App registers
notification categories. Core does **not** deliver APNs notifications and this
release ships no relay: the first App release states that remote notifications
are not delivered (thebe ADR 0015). When delivery is added it arrives as a
separately deployed Push Relay that Core signs events for, so a self-hosted Core
never embeds Thebe's APNs credentials. Until then, do not run or document a relay
as part of this deployment.

## 4. Network exposure and the iOS connection

Pick one TLS path; all three keep Core on loopback and never expose the token in
plaintext off-host:

```bash
# a) Tailscale Serve (recommended for a personal tailnet)
tailscale serve --bg --https=443 http://127.0.0.1:8787
#    → https://<machine>.<tailnet>.ts.net   ; add that name to THEBE_ALLOWED_HOSTS

# b) Tailscale Funnel (public HTTPS; still token-gated) — only if you need it
tailscale funnel --bg 443 http://127.0.0.1:8787

# c) Reverse proxy on the host (nginx/Caddy) terminating TLS
#    proxy_pass http://127.0.0.1:8787;  add the public name to THEBE_ALLOWED_HOSTS
```

Rules:

- Add every host name a client uses (Tailscale name, LAN IP, proxy name) to
  `THEBE_ALLOWED_HOSTS`; otherwise mutating requests from that name get `403`.
- Do not publish `8787` on `0.0.0.0`, and do not put Core behind a proxy that
  strips the `Host` header.
- iOS: in the App, set the Core URL to the TLS endpoint and paste
  `THEBE_TOKEN`. Confirm `GET /v1/health` succeeds and the API docs open, then
  open Activity — the App's first product call is `GET /v1/activity`.

## 5. Process isolation boundary

Core and its Pi runtime do **not** provide an OS sandbox by themselves. The
container is the release boundary:

- `read_only: true` root filesystem, `cap_drop: ALL`,
  `no-new-privileges:true`, `/tmp` on tmpfs.
- Only `/data` and `/workspace` are writable; `/workspace` is the single
  authorization boundary (`THEBE_WORKSPACE_DIR`).
- Inside a container, `THEBE_SANDBOX=bwrap` is unavailable; use the guard layers
  that do work there (`THEBE_COMMAND_GUARD`, the Docker API guard) and see
  `docs/configuration.md` for `THEBE_SCENARIO`. `THEBE_SANDBOX=gondolin` needs
  KVM/QEMU and is not available in the default container — run Core on the host
  if you need micro-VM isolation.
- Choosing the host-service path instead means you provide the dedicated user
  (no login shell, no sudo) and the filesystem permissions yourself.

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
bash scripts/release-check.sh     # tsc --noEmit + vite build + vitest run + smoke
```

CI runs the same gate (`.github/workflows/release-check.yml`) on every push and
pull request, so a release candidate on a clean host reproduces what CI saw.

### Container verification after an upgrade

```bash
docker compose exec thebe-core node scripts/check-pi-resolution.mjs
```

It must print `pi-ai OK …`. `MISSING` means the production install lost the
nested `@earendil-works/pi-ai` copy; reinstall with
`corepack pnpm install --frozen-lockfile --prod`.

## 11. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401` on every route | Missing/incorrect `X-Thebe-Token` | Send the token from `deploy/.env`; `/docs` is the only token-free route |
| `403` on writes, reads fine | `Host` header not in the allowlist | Add the client's host name to `THEBE_ALLOWED_HOSTS` and restart |
| Container unhealthy; logs show `THEBE_TOKEN is required` | `NODE_ENV=production` without a token | Set `THEBE_TOKEN` in `deploy/.env` |
| `pnpm --version` hangs | Known release-environment issue (#5 P1) | Use `node_modules/.bin/*` or `bash scripts/release-check.sh` |
| `Could not find @earendil-works/pi-ai dist` | Pruned install lost the nested copy | Reinstall with `--frozen-lockfile --prod`; verify with `scripts/check-pi-resolution.mjs` |
| Agent cannot write files | `/workspace` not writable by uid 1000 | `chown 1000:1000` the host folder, or grant group write |

## 12. What has been verified on this checkout

- Local gates pass on macOS with Node 22 and the existing `node_modules`:
  `tsc --noEmit`, `vite build`, the full Vitest suite, and
  `scripts/smoke.mjs` (8/8 checks, including SIGTERM exit `0` and a settings
  write surviving a Core restart).
- `scripts/check-pi-resolution.mjs` resolves pi-ai in the current install.
- Not verified here: the Docker build itself (no container runtime on the
  authoring machine). The Dockerfile and compose file mirror the verified local
  layout; run `scripts/smoke.mjs` against the first container deployment and
  report any deviation.
