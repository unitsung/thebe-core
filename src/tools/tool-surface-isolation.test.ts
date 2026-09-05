import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const toolsDir = dirname(fileURLToPath(import.meta.url));

describe("Tool Layer isolation", () => {
  it("does not import Arcane SDK, fetch, or docker.sock", async () => {
    const names = (await readdir(toolsDir)).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    const sources = await Promise.all(
      names.map((name) => readFile(join(toolsDir, name), "utf8")),
    );
    const joined = sources.join("\n");
    expect(joined).not.toMatch(/arcane-adapter/i);
    expect(joined).not.toMatch(/docker\.sock/);
    expect(joined).not.toMatch(/\bfetch\s*\(/);
    expect(joined).not.toMatch(/from ["']node:http["']/);
  });
});
