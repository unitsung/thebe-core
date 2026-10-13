import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic, writeFileAtomicSync } from "./atomic-write.ts";

describe("atomic file writes", () => {
  it("replaces the file content and leaves no temp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-atomic-"));
    const target = join(dir, "data.json");

    await writeFileAtomic(target, '{"v":1}', "utf8");
    expect(await readFile(target, "utf8")).toBe('{"v":1}');

    await writeFileAtomic(target, '{"v":2}', "utf8");
    expect(await readFile(target, "utf8")).toBe('{"v":2}');

    writeFileAtomicSync(target, '{"v":3}', "utf8");
    expect(await readFile(target, "utf8")).toBe('{"v":3}');

    // Only the target remains: no `.tmp` leftovers.
    expect(await readdir(dir)).toEqual(["data.json"]);
  });

  it("keeps a concurrent reader from ever seeing a partial file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-atomic-race-"));
    const target = join(dir, "data.json");
    await writeFile(target, JSON.stringify({ n: -1 }), "utf8");

    const rounds = 200;
    await Promise.all([
      ...Array.from({ length: rounds }, (_, n) =>
        writeFileAtomic(target, JSON.stringify({ n }), "utf8")
      ),
      ...Array.from({ length: rounds }, async () => {
        // Every read must parse: a non-atomic write could expose an empty file.
        JSON.parse(await readFile(target, "utf8"));
      }),
    ]);

    JSON.parse(await readFile(target, "utf8"));
    expect(await readdir(dir)).toEqual(["data.json"]);
  });
});
