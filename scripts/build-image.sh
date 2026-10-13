#!/usr/bin/env bash
#
# Build the Core container image on this host and verify it, without touching a
# registry (publishing is the publish-image workflow's job). Fast on a Linux
# server; on macOS it goes through the Docker Desktop/colima VM.
#
# BuildKit is required (the Dockerfile mounts a cache); Docker 23+ and Compose v2
# enable it by default.
#
# usage: bash scripts/build-image.sh [tag]     # default: thebe-core:local

set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:-thebe-core:local}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed or not on PATH" >&2
  exit 1
fi

export DOCKER_BUILDKIT=1

echo "== docker build: $tag"
docker build -t "$tag" .

echo "== pi-ai resolution (inside the image)"
docker run --rm --entrypoint node "$tag" scripts/check-pi-resolution.mjs

echo "== smoke (inside the image)"
docker run --rm --entrypoint node "$tag" scripts/smoke.mjs

echo "== built and verified: $tag"
