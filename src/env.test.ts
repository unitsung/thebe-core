import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envLocalCandidates, loadEnvLocal } from "./env.ts";

describe("loadEnvLocal", () => {
  it("walks up from a nested dist/chunks path to the package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "thebe-env-"));
    const nested = join(root, "dist", "chunks");
    await mkdir(nested, { recursive: true });
    const key = `THEBE_ENV_TEST_${Date.now()}`;
    await writeFile(join(root, ".env.local"), `${key}=from-root\n`, "utf8");
    expect(envLocalCandidates(nested)).toContain(join(root, ".env.local"));
    expect(envLocalCandidates(nested)).toContain(join(nested, ".env.local"));
    delete process.env[key];
    loadEnvLocal(nested);
    expect(process.env[key]).toBe("from-root");
    delete process.env[key];
  });
});
