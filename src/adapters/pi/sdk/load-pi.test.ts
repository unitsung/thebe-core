import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPiAiDist, piAiDistDir, piDistDir } from "./load-pi.ts";

/**
 * Core loads pi-ai out of the Pi agent's dependency tree instead of depending on
 * it directly (see `packaging.test.ts`), so both install layouts must resolve.
 */
describe("pi-ai resolution", () => {
  it("finds pi-ai the way a production install keeps it", () => {
    const dist = piAiDistDir();
    expect(existsSync(join(dist, "index.js"))).toBe(true);

    // A pruned install drops the top-level symlink but keeps pi-ai next to the
    // agent package that needs it.
    const fromAgentPackage = findPiAiDist([realpathSync(piDistDir())]);
    if (fromAgentPackage) {
      expect(fromAgentPackage).toContain(join("@earendil-works", "pi-ai"));
      expect(existsSync(join(fromAgentPackage, "api", "google-shared.js"))).toBe(true);
    }
  });
});
