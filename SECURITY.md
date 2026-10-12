# Security Policy

## Supported versions

Development happens on `dev`. There is no tagged release and no published
container image. Security fixes land on `dev`. Build the image from the commit
you run, and keep the `/data` directory when you move to a newer checkout.

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
- **Approval by default.** Permission mode defaults to `ask`; shell commands are
  risk-graded before they run, tool output and MCP data are treated as
  untrusted, and secrets are redacted.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full operational security
guidance, including TLS, backups, and secret handling.
