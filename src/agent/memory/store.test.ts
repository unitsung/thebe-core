import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyMemory } from "./memory.ts";
import { createJsonMemoryStore } from "./store.ts";

function memoryPath(): string {
  return join(mkdtempSync(join(tmpdir(), "thebe-memory-store-")), "memory.json");
}

describe("memory store", () => {
  it("refuses to overwrite a memory file it cannot parse", () => {
    const path = memoryPath();
    writeFileSync(path, '{"user":');

    expect(() => createJsonMemoryStore(path).save(emptyMemory())).toThrow(
      /Refusing to overwrite/
    );
    expect(readFileSync(path, "utf8")).toBe('{"user":');
  });

  it("reads an empty memory from a damaged file without hiding startup", () => {
    const path = memoryPath();
    writeFileSync(path, '{"user":');

    expect(createJsonMemoryStore(path).load()).toEqual(emptyMemory());
  });
});
