import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { resolveThebeAuth } from "./credentials.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("credential resolution", () => {
  it("goes through pi-ai models.getAuth", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const spy = vi.spyOn(models, "getAuth");
    await resolveThebeAuth(models, faux.getModel().provider);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toBe(faux.getModel().provider);
    spy.mockRestore();
  });

  it("does not introduce Thebe-owned OAuth token storage or refresh", async () => {
    const files = await collectTs(srcRoot);
    const joined = (
      await Promise.all(files.map((path) => readFile(path, "utf8")))
    ).join("\n");
    expect(joined).not.toMatch(/oauth[_-]?token[_-]?store/i);
    expect(joined).not.toMatch(/refreshOAuth/i);
    expect(joined).not.toMatch(/refresh_token/i);
    expect(joined).toContain("models.getAuth");
  });
});

async function collectTs(dir: string): Promise<string[]> {
  const names = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of names) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      out.push(...(await collectTs(path)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}
