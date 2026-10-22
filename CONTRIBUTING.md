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
npm run lint                     # oxlint
npm run format                   # oxfmt, writes in place
npm test                         # vitest run
bash scripts/release-check.sh    # typecheck + lint + build + tests + live smoke test
```

`scripts/release-check.sh` is the release gate and runs in CI
(`.github/workflows/verify.yml`) on every push and pull request. Use
`bash scripts/release-check.sh --no-smoke` to skip the smoke test.

A Husky `pre-commit` hook runs lint-staged (oxfmt on staged files, oxlint on
staged JS/TS), then `tsc`, `oxlint` and the tests affected by the change. A `commit-msg` hook enforces
[Conventional Commits](https://www.conventionalcommits.org/) via commitlint
(`feat:`, `fix:`, `chore:`, `docs:`, …). Install both with `npm install` (the
`prepare` script wires `.husky/`).

## Pull requests

1. Fork the repository and branch from `dev`.
2. Make the smallest coherent change, keeping the Agent interface thin and
   variable behavior behind a clear seam.
3. Add or update a regression test when behavior changes or a bug is fixed.
4. Update the focused `docs/` page when a user-visible workflow or configuration
   contract changes.
5. Sign off every commit (see below).
6. Confirm `bash scripts/release-check.sh` passes, then open a pull request
   describing the changed behavior and the checks you ran.

Preserve unrelated work in the tree. Avoid destructive Git operations and broad
refactors that are not part of the change.

## Conventions

- TypeScript, ESM, Node 24. Keep imports inside their layer: delivery code calls
  the Agent interface and never recreates the agent loop.
- Treat tool output and remote MCP data as untrusted; preserve approval gates and
  redaction paths.
- Keep `AGENTS.md` concise; record domain facts in `CONTEXT.md` or focused docs.

## Developer Certificate of Origin

Every commit in a pull request must carry a `Signed-off-by` line, which states that you wrote the
change or have the right to submit it under this project's license
([developercertificate.org](https://developercertificate.org/)). Add it with:

```bash
git commit -s            # new commits
git commit --amend -s    # the last commit
git rebase --signoff dev  # every commit of your branch
```

The sign-off uses your Git `user.name` and `user.email`. CI runs `scripts/check-dco.sh` on pull
requests and fails when a commit has none. There is no separate CLA.

## License

By contributing you agree that your contributions are licensed under the
[Apache-2.0 License](LICENSE).
