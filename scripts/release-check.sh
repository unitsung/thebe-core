#!/usr/bin/env bash
#
# Deterministic release check: typecheck, build, full test suite, smoke test.
#
# It calls the local binaries directly instead of going through pnpm, because
# `pnpm --version` / `pnpm typecheck` can hang in some release environments
# (see thebe-core issue #5, P1). CI runs the same three checks plus the smoke
# test, so an operator can reproduce a release gate on a clean host.
#
# usage: bash scripts/release-check.sh [--no-smoke]

set -euo pipefail
cd "$(dirname "$0")/.."

with_smoke=1
for arg in "$@"; do
  case "$arg" in
    --no-smoke) with_smoke=0 ;;
    --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

bin=node_modules/.bin
if [ ! -x "$bin/tsc" ] || [ ! -x "$bin/vite" ] || [ ! -x "$bin/vitest" ]; then
  echo "missing local binaries under $bin." >&2
  echo "install dependencies first, for example:" >&2
  echo "  corepack pnpm install --frozen-lockfile   # or: pnpm install --frozen-lockfile" >&2
  exit 1
fi

echo "== typecheck: $bin/tsc --noEmit"
"$bin/tsc" --noEmit

echo "== build: $bin/vite build"
"$bin/vite" build

echo "== test: $bin/vitest run"
"$bin/vitest" run

if [ "$with_smoke" = "1" ]; then
  echo "== smoke: node scripts/smoke.mjs"
  node scripts/smoke.mjs
fi

echo "== release check OK"
