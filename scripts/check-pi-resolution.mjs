#!/usr/bin/env node

/**
 * Verifies that a deployed Core install can resolve `@earendil-works/pi-ai`.
 *
 * pi-ai is only a dev dependency of Core, so a production install (`npm prune
 * --omit=dev`) keeps it inside the Pi agent package's dependency tree instead of
 * at the top level. `src/adapters/pi/sdk/load-pi.ts` walks the same path at
 * runtime, and this walk is intentionally written out again: the check must stay
 * independent of the code it verifies. The container image runs it in CI after
 * the build and prune; run it by hand after an upgrade with:
 *
 *   docker compose exec thebe-core node scripts/check-pi-resolution.mjs
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function findPiAiDist(roots, limit = 12) {
  for (const root of roots) {
    let dir = root;
    for (let index = 0; index < limit; index += 1) {
      const candidate = join(
        dir,
        "node_modules",
        "@earendil-works",
        "pi-ai",
        "dist",
        "index.js"
      );
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return undefined;
}

export function piAiRoots(coreRootPath = coreRoot) {
  const roots = [coreRootPath];
  try {
    roots.push(
      realpathSync(
        join(coreRootPath, "node_modules", "@earendil-works", "pi-coding-agent")
      )
    );
  } catch {
    // A missing agent package is reported by the walk itself.
  }
  return roots;
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const found = findPiAiDist(piAiRoots());
  if (found) {
    console.log(`pi-ai OK ${found}`);
  } else {
    console.error(
      "pi-ai MISSING: reinstall dependencies with `npm ci` and keep the production tree (`npm prune --omit=dev`); pi-ai ships inside the pi-coding-agent package"
    );
    process.exitCode = 1;
  }
}
