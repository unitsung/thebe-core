import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyThebeApiKey, loginThebeOAuth } from "./credentials.ts";
import { createFakeRuntime } from "../runtime/fake-runtime.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("credential resolution", () => {
  it("API keys go through runtime auth", async () => {
    const fake = createFakeRuntime();
    await applyThebeApiKey(fake.runtime.auth(), "opencode", "sk-test");
    expect(fake.apiKeys.get("opencode")).toBe("sk-test");
  });

  it("OAuth login goes through runtime auth", async () => {
    const fake = createFakeRuntime();
    const result = await loginThebeOAuth(fake.runtime.auth(), "opencode");
    expect(result).toEqual({ kind: "oauth", providerId: "opencode" });
    expect(fake.oauthLogins).toEqual(["opencode"]);
  });

  it("does not introduce Thebe-owned OAuth token storage or refresh", async () => {
    const files = await collectTs(srcRoot);
    const outsidePi = files.filter(
      (path) => !path.includes(`${join("runtime", "pi")}`),
    );
    const joined = (
      await Promise.all(outsidePi.map((path) => readFile(path, "utf8")))
    ).join("\n");
    expect(joined).not.toMatch(/oauth[_-]?token[_-]?store/i);
    expect(joined).not.toMatch(/refreshOAuth/i);
    expect(joined).not.toMatch(/async function refresh\(/);
    expect(joined).not.toMatch(/function refreshOAuth/);
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
