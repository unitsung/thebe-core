# Security Policy

## Supported versions

Development happens on `dev`. There is no tagged release yet, so no image has
been published to the container registry. Security fixes land on `dev`. Build
the image from the commit you run, and keep the `/data` directory when you move
to a newer checkout. Once releases are tagged, this section will name the
versions that receive fixes.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting for this repository: open the
**Security** tab and choose **Report a vulnerability**. Include the commit you are running, a description, and a minimal reproduction
if you can.

## Deployment security model

Thebe Core is designed to run on your own hardware:

- **Token-gated.** `NODE_ENV=production` refuses to start without `THEBE_TOKEN`,
  and every route except `/docs` and `/openapi.json` requires it as
  `X-Thebe-Token`.
- **Loopback by default.** The supported container publishes `127.0.0.1:8787`
  only. Put non-loopback access behind TLS (Tailscale Serve/Funnel or a reverse
  proxy) and add every host name to `THEBE_ALLOWED_HOSTS`.
- **One container boundary.** Run Core in its container, with the workspace
  (`THEBE_WORKSPACE_DIR`) as the only tree the agent may read or write.
- **Approval by default.** Permission mode defaults to `manual` (ask each time);
  shell commands are risk-graded before they run, tool output and MCP data are
  treated as untrusted, and secrets are redacted. An append-only audit log
  (`audit.jsonl` in the agent store) records each call's method, a hash of its
  parameters, and the result.
- **Shared token.** One token (or one per device, `thebe token create`) grants
  full access to the API: there are no scopes. Anyone holding a token can read
  the audit log, change settings, approve pending permissions, and run any tool
  the permission mode allows. Treat it like a password.
- **Opting out of safety.** `bypassPermissions` lifts the command guard, the
  sandbox and approval for one session. Graphical clients and the TUI ask before turning it
  on; the HTTP API accepts it from any token holder.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full operational security
guidance, including TLS, backups, and secret handling.
