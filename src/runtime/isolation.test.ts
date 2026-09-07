import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const piWrapper = join(srcRoot, "runtime", "pi");

const FORBIDDEN = [
  "@earendil-works/pi-coding-agent",
  "AgentHarness",
  "createAgentAdapter",
  "thebeConvertToLlm",
  "exportRunJsonl",
  "exportRunHtml",
  "createRunStore",
];

describe("runtime isolation", () => {
  it("keeps Pi coding-agent and old harness types inside the Pi wrapper", async () => {
    const files = await collectProductionTs(srcRoot);
    const outside = files.filter((path) => !path.startsWith(piWrapper));
    const leaks: string[] = [];
    for (const path of outside) {
      const text = await readFile(path, "utf8");
      for (const token of FORBIDDEN) {
        if (text.includes(token)) {
          leaks.push(`${relative(srcRoot, path)}: ${token}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("does not spawn the Pi CLI", async () => {
    const files = await collectProductionTs(srcRoot);
    const joined = (
      await Promise.all(files.map((path) => readFile(path, "utf8")))
    ).join("\n");
    expect(joined).not.toMatch(/spawn\(.*\bpi\b/);
    expect(joined).not.toMatch(/execFile\(.*["']pi["']/);
  });
});

async function collectProductionTs(dir: string): Promise<string[]> {
  const names = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of names) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      out.push(...(await collectProductionTs(path)));
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
