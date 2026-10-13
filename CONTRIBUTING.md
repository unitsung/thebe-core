# Contributing to Thebe Core

Thanks for helping improve Thebe Core. This repository is the server. The Apple
app is a separate project and is not part of the work accepted here.

This guide covers the local workflow for a change. The architecture and coding
rules live in [AGENTS.md](AGENTS.md) and [CONTEXT.md](CONTEXT.md).

## Prerequisites

- Node 24 LTS (npm is bundled). No external services are required to build or run
  the test suite.

## Setup

```bash
npm ci
cp .env.example .env
```

`THEBE_WORKSPACE_DIR` is required to start the Core process; it never falls back
to the process working directory.

## Checks

Run the narrowest check that covers your change while iterating, then the full
gate before opening a pull request:

```bash
npm run typecheck                # tsc --noEmit
npm test                         # vitest run
bash scripts/release-check.sh    # typecheck + build + tests + live smoke test
```

`scripts/release-check.sh` is the release gate and runs in CI
(`.github/workflows/release-check.yml`) on every push and pull request. Use
`bash scripts/release-check.sh --no-smoke` to skip the smoke test.

## Pull requests

1. Fork the repository and branch from `dev`.
2. Make the smallest coherent change, keeping the Agent interface thin and
   variable behavior behind a clear seam.
3. Add or update a regression test when behavior changes or a bug is fixed.
4. Update the focused `docs/` page when a user-visible workflow or configuration
   contract changes.
5. Confirm `bash scripts/release-check.sh` passes, then open a pull request
   describing the changed behavior and the checks you ran.

Preserve unrelated work in the tree. Avoid destructive Git operations and broad
refactors that are not part of the change.

## Conventions

- TypeScript, ESM, Node 24. Keep imports inside their layer: delivery code calls
  the Agent interface and never recreates the agent loop.
- Treat tool output and remote MCP data as untrusted; preserve approval gates and
  redaction paths.
- Keep `AGENTS.md` concise; record domain facts in `CONTEXT.md` or focused docs.

## License

By contributing you agree that your contributions are licensed under the
[Apache-2.0 License](LICENSE).
