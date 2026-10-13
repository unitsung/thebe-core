# Containers without a panel: the Docker Engine API through a restricted proxy

Status: accepted (2026-10-13).

## Context

Core's container capability (`container.list` / `inspect` / `logs` /
`status_summary`, plus the approved `container.restart` action) is declared by the
`ContainerInfoProvider` interface, and the only shipped implementation was
`ArcaneAdapter`. A self-hoster who runs no container panel therefore gets an empty
container surface, even when Docker is right there on the host.

`CONTEXT.md` warns against Core talking to `docker.sock` directly or growing a
homegrown Docker manager. The App-side plan had already decided the Core container
second implementation: reach the Docker Engine API through a restricted
`docker-socket-proxy`, keep Arcane first when it is configured, and keep writes on
the approval → execute → verify → receipt path. This ADR records that decision.

## Decision

Core ships `DockerEngineAdapter` (`src/adapters/docker/adapter.ts`) as a second
`ContainerInfoProvider`:

- It talks only to the operator-configured proxy root
  (`THEBE_DOCKER_PROXY_URL`, e.g. `http://127.0.0.1:2375`); it never opens
  `docker.sock` and never accepts a host from a request. Redirects are refused.
- The proxy is expected to be restricted (`docker-socket-proxy` with only the
  read endpoints and `POST /containers/*/restart` enabled). Core does not
  authenticate to it; reach it over loopback or Tailscale and publish nothing.
- `ARCANE_BASE_URL`/`ARCANE_API_KEY` win when both are set; the Docker provider is
  the fallback, and neither set leaves the existing empty stub.
- The reads map to the same `ContainerSummary` / `ContainerDetail` types. The one
  write is `restartContainer`, exposed only through `POST /v1/action`
  (`container.restart`) with on-device approval; it is never attached to the model
  tool loop.
- `ResourceRef.provider` gains a `docker` value so a client can tell which backend
  answered.

## Consequences

- The Docker Engine API version is not pinned: unversioned paths are used unless
  `THEBE_DOCKER_API_VERSION` is set, so the daemon negotiates.
- Logs may be a multiplexed stream (non-TTY) or plain text (TTY/proxy); Core
  demultiplexes the framed form and falls back to UTF-8 text.
- No host ports are discovered beyond what the container reports; the existing
  Emby/Jellyfin verification in the restart receipt still applies.
- Real-provider acceptance (a live proxy and a live restart) remains a separate
  check; the adapter is covered by unit and integration tests against a fake
  Docker API.
- This does not make Core a general Docker manager: only the operations the
  `ContainerInfoProvider` contract already declares are implemented.
