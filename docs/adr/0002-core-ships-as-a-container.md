# Core ships as one container, not a host service

Status: accepted (2026-09-26).

## Context

Core is a headless Node service (`node dist/serve.js`) that an iOS App connects
to over HTTP. Self-hosters run it on a NAS or a homelab host next to dozens of
other services. Thebe Core itself supplies no OS sandbox: the command guard,
workspace boundary, and audit layer are application-level, and Pi's sandbox
backends (`bwrap`, Gondolin) are host feature-dependent. The release task
The release-readiness work asked for **one** supported deployment shape, a reproducible
install path, and a documented isolation boundary.

Options considered: a packaged Node distribution (tarball + systemd unit), a
container image, or "host service, operator-managed".

## Decision

The supported shape is a single OCI container built from this repository's
`Dockerfile`, run through `deploy/docker-compose.yml`, with:

- one writable data mount (`/data`: config, Pi agent, agent store, outputs),
- one workspace mount (`/workspace`) as the single authorization boundary,
- loopback-only port publishing and TLS terminated on the host
  (Tailscale Serve/Funnel or a reverse proxy),
- `read_only` root filesystem, dropped capabilities, `no-new-privileges`, `/tmp`
  on tmpfs.

`docs/DEPLOYMENT.md` is the operator runbook. The host-service path stays
possible for development and is documented, but it is not the release shape and
gets no support claim.

## Consequences

- Isolation is the container's, not the agent's: operators must not add host
  mounts beyond `/data` and `/workspace`, and must not run the container as root
  on the host or with the Docker socket mounted.
- `bwrap`-based sandboxing is unavailable inside the container; `gondolin`
  micro-VM isolation requires running Core on a host with KVM/QEMU.
- Upgrades are "swap the image, keep `/data`", which requires the store formats
  to stay additive (documented in the runbook's compatibility policy).
- The image carries Node and the pinned pnpm only for installation; the process
  runs the prebuilt `dist/` entry with production dependencies.
- A packaged Node distribution can be added later as a second, optional shape,
  but nothing in this decision blocks it.
