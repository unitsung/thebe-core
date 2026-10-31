import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncAgentModelsFile } from "./agent-dir.ts";

describe("syncAgentModelsFile", () => {
  it("leaves a models.json it cannot parse in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "thebe-agent-dir-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, '{"providers":');

    expect(() => syncAgentModelsFile(dir)).toThrow(/Refusing to overwrite/);
    expect(readFileSync(modelsPath, "utf8")).toBe('{"providers":');
  });
});
