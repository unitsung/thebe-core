import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Node packaging", () => {
  it("uses Vite 8 Rolldown options with named chunk groups under dist/chunks", async () => {
    const config = await readFile(join(root, "vite.config.ts"), "utf8");
    expect(config).toContain("rolldownOptions");
    expect(config).toContain("codeSplitting");
    expect(config).toContain('chunkFileNames: "chunks/[name]-[hash].js"');
    expect(config).not.toContain("experimentalMinChunkSize");
    expect(config).not.toContain("thebe-inline-node-entries");
    expect(config).not.toContain("rollupOptions");
  });

  it("pins @earendil-works/pi-coding-agent in package.json and the lockfile", async () => {
    const pkg = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.["@earendil-works/pi-coding-agent"]).toBe("0.85.0");
    const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
    expect(lock).toContain("@earendil-works/pi-coding-agent@0.85.0");
  });

  it("dist keeps Node entries at the root and shared code in hashed chunks/", async () => {
    const names = await readdir(join(root, "dist"));
    expect(names).toEqual(expect.arrayContaining(["serve.js", "tui.js", "index.js", "chunks"]));
    const chunks = await readdir(join(root, "dist", "chunks"));
    expect(chunks.some((name) => name.endsWith(".js"))).toBe(true);
    expect(chunks.some((name) => /-[a-z0-9]+\.js$/i.test(name))).toBe(true);
    const serve = await readFile(join(root, "dist/serve.js"), "utf8");
    expect(serve).toMatch(/from ["']\.\/chunks\//);
  });
});
