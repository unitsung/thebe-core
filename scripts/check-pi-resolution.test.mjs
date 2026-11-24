import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPiAiDist, piAiRoots } from "./check-pi-resolution.mjs";

const dirs = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "thebe-pi-resolution-"));
  dirs.push(dir);
  return dir;
}

function installPiAi(root) {
  const dist = join(root, "node_modules", "@earendil-works", "pi-ai", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.js"), "export {};\n");
  return join(dist, "index.js");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("pi-ai resolution check", () => {
  it("finds pi-ai nested inside the Pi agent package, as a production install leaves it", () => {
    const app = fixture();
    const agent = join(
      realpathSync(app),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent"
    );
    mkdirSync(agent, { recursive: true });
    // pi-ai is not at the top level; it ships inside the agent's dependency tree.
    const entry = installPiAi(agent);

    expect(findPiAiDist(piAiRoots(app))).toBe(entry);
  });

  it("reports a missing pi-ai instead of a path that does not load", () => {
    const app = fixture();
    mkdirSync(join(app, "node_modules"), { recursive: true });

    expect(findPiAiDist(piAiRoots(app))).toBeUndefined();
  });

  it("checks Core's own tree first, then the real path of the agent package", () => {
    const app = fixture();
    const agentLink = join(
      app,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent"
    );
    mkdirSync(agentLink, { recursive: true });
    installPiAi(app);

    const roots = piAiRoots(app);
    expect(roots[0]).toBe(app);
    expect(roots).toContain(realpathSync(agentLink));
    // The walk starts at Core, so its own tree wins when both can resolve pi-ai.
    const found = findPiAiDist(roots);
    expect(found.endsWith(join("pi-ai", "dist", "index.js"))).toBe(true);
    expect(found.startsWith(app)).toBe(true);
  });
});
