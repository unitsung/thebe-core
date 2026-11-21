#!/usr/bin/env node
/**
 * Pi layout check: the Pi runtime is located at runtime by
 * src/adapters/pi/sdk/load-pi.ts, which walks up from Core's own files looking
 * for the Pi agent dist and the pi-ai dist under node_modules. If a dependency
 * upgrade moves or drops those files, Core fails only when a session starts,
 * so check the layout here, where CI and the release gate run it.
 *
 * usage: node scripts/check-pi-layout.mjs
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = [
  {
    label: "@earendil-works/pi-coding-agent dist",
    path: ["@earendil-works", "pi-coding-agent", "dist", "core", "sdk.js"],
  },
  {
    label: "@earendil-works/pi-ai dist",
    path: ["@earendil-works", "pi-ai", "dist", "index.js"],
  },
];

function findFile(roots, segments) {
  for (const root of roots) {
    let dir = root;
    for (let i = 0; i < 12; i++) {
      const candidate = join(dir, "node_modules", ...segments);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

const roots = [repoRoot];
try {
  // When the install is pruned (pnpm production), the agent package is a link:
  // resolve it so the sibling pi-ai link is found too.
  roots.push(
    realpathSync(join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"))
  );
} catch {
  // The package itself is missing; findFile reports it below.
}

let failed = false;
for (const entry of REQUIRED) {
  const found = findFile(roots, entry.path);
  if (found) {
    console.log(`ok: ${entry.label} -> ${found}`);
  } else {
    console.error(
      `missing: ${entry.label} (looked for node_modules/${entry.path.join("/")} from ${repoRoot})`
    );
    failed = true;
  }
}

if (failed) {
  console.error(
    "Pi layout check failed: run npm ci and check the @earendil-works dependency versions."
  );
  process.exit(1);
}
console.log("Pi layout check OK");
