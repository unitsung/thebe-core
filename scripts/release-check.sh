#!/usr/bin/env bash
#
# Deterministic release check: typecheck, lint, build, full test suite, smoke test.
#
# It calls the local binaries directly; CI runs the same checks plus the smoke
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
if [ ! -x "$bin/tsc" ] || [ ! -x "$bin/tsdown" ] || [ ! -x "$bin/vitest" ] || [ ! -x "$bin/oxlint" ]; then
  echo "missing local binaries under $bin." >&2
  echo "install dependencies first, for example:" >&2
  echo "  npm ci" >&2
  exit 1
fi

echo "== typecheck: $bin/tsc --noEmit"
"$bin/tsc" --noEmit

echo "== lint: $bin/oxlint"
"$bin/oxlint"

echo "== build: $bin/tsdown"
"$bin/tsdown"

echo "== test: $bin/vitest run"
"$bin/vitest" run

if [ "$with_smoke" = "1" ]; then
  echo "== smoke: node scripts/smoke.mjs"
  node scripts/smoke.mjs
fi

echo "== release check OK"
