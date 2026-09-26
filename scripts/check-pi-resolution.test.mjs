import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPiAiDist, piAiRoots } from "./check-pi-resolution.mjs";

function writePiAiInstall(base) {
  const dist = join(base, "node_modules", "@earendil-works", "pi-ai", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.js"), "");
  return join(dist, "index.js");
}

describe("pi-ai resolution check", () => {
  it("finds pi-ai nested inside the agent package", () => {
    const root = join(tmpdir(), `thebe-pi-check-${Date.now()}-nested`);
    try {
      const agentRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
      mkdirSync(agentRoot, { recursive: true });
      const expected = writePiAiInstall(agentRoot);
      expect(findPiAiDist([agentRoot])).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks up from a nested agent location", () => {
    const root = join(tmpdir(), `thebe-pi-check-${Date.now()}-deep`);
    try {
      const expected = writePiAiInstall(root);
      const agentRoot = join(root, "store", "deep", "agent");
      mkdirSync(agentRoot, { recursive: true });
      expect(findPiAiDist([agentRoot])).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a missing install", () => {
    const root = join(tmpdir(), `thebe-pi-check-${Date.now()}-missing`);
    try {
      const agentRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
      mkdirSync(agentRoot, { recursive: true });
      expect(findPiAiDist([agentRoot])).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("always includes the Core root in the search roots", () => {
    const roots = piAiRoots("/nonexistent-core-root");
    expect(roots[0]).toBe("/nonexistent-core-root");
  });
});
