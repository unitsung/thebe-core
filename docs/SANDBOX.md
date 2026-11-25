# Sandbox status

Last reviewed: 2026-11-25.

Thebe has two runtime paths and two deployment shapes. They do not provide the
same sandbox.

| Runtime | Host | Release container |
| --- | --- | --- |
| DSH (default) | DSH-owned `workspace-write` file sandbox; approvals forwarded to Core | No nested host sandbox; the container is the boundary; approvals remain `ask` |
| Pi compatibility | `@anthropic-ai/sandbox-runtime` with Seatbelt on macOS and bubblewrap on Linux | No nested host sandbox; the container is the boundary |

## Implemented

- Pi host writes are limited to the workspace and temporary directory. Reads
  are open except `~/.ssh`, `~/.aws`, `~/.gnupg`, and `~/.thebe`.
- Pi host network access starts closed. An unmatched host asks through the
  active Session, remembered allows and denies persist, and overlapping
  sandboxed commands cannot be attributed to one Session so the host is denied.
- Missing Pi dependencies and failed setup refuse the command. The wrapper has
  no unconfined fallback.
- The release container uses a read-only root filesystem, drops all Linux
  capabilities, enables `no-new-privileges`, and mounts `/tmp` as tmpfs.
- DSH sessions use a runtime-owned file sandbox, explicit `ask` approval, and a
  private DSH home per Core Session. A container disables the nested DSH host
  sandbox and keeps the container boundary plus approval.
- `GET /v1/system/isolation`, `thebe doctor`, and startup warnings expose the
  effective mode.

## Verified

- The pinned sandbox runtime passed its dependency probe on the development Mac.
- The Pi full-access integration test ran a real Seatbelt boundary: writes
  outside the workspace were denied before full access and succeeded after it.
- The full test suite covers policy construction, dependency refusal, network
  list handling, isolation reporting, and container posture.

## Open gaps

- **DSH host network access.** DSH's current sandbox vocabulary covers file
  effects only. Core's Seatbelt/bubblewrap network allowlist applies to Pi, not
  DSH-native tools.
- **DSH approval arguments.** The SDK approval request exposes a tool name but
  not its arguments. Core can require the person's decision, but its
  argument-level command-risk rules cannot inspect a DSH-native shell command.
- **Container egress.** The supported container has no network egress policy.
- **Read scope.** The Pi sandbox deliberately allows broad host reads outside
  the denied credential directories. A runtime process in the release container
  can also see the writable `/data` mount. Workspace confinement governs Core
  file tools and sandbox writes; it is not a read-only view of every mounted
  path.
- **Windows.** The upstream sandbox has an alpha Windows backend. Thebe does not
  currently claim a verified Windows host posture.

## Operator checks

```bash
thebe doctor
curl -s -H "X-Thebe-Token: $THEBE_TOKEN" \
  http://127.0.0.1:8787/v1/system/isolation
```

The report includes `runtimeId`, `sandbox.mode` (`off`, `os`, or `dsh`), and any
known relaxed boundary.
