import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStorageConfig } from "../../../app/storage-config.ts";
import { runStorageCommand } from "./storage.ts";

async function withConfigDir(
  run: (dir: string, configPath: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "thebe-storage-cli-"));
  const previous = process.env.THEBE_CONFIG_DIR;
  process.env.THEBE_CONFIG_DIR = dir;
  try {
    await run(dir, join(dir, "config.json"));
  } finally {
    if (previous === undefined) delete process.env.THEBE_CONFIG_DIR;
    else process.env.THEBE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: (line: string) => lines.push(line),
    error: (line: string) => errors.push(line),
  };
}

describe("thebe storage", () => {
  it("adds, lists, tests, and removes a backend", async () => {
    await withConfigDir(async (dir, configPath) => {
      const out = capture();
      expect(
        await runStorageCommand(
          {
            kind: "storage-add",
            makeDefault: true,
            backend: { id: "media", type: "local", roots: [dir] },
          },
          out
        )
      ).toBe(0);
      expect(out.lines.join("\n")).toContain("saved media (local) as default");
      expect(loadStorageConfig({ path: configPath, env: {} }).defaultId).toBe(
        "media"
      );
      expect(
        JSON.parse(await readFile(configPath, "utf8")).storage.backends
      ).toEqual([{ id: "media", type: "local", roots: [dir] }]);

      const list = capture();
      expect(await runStorageCommand({ kind: "storage-list" }, list)).toBe(0);
      const text = list.lines.join("\n");
      expect(text).toContain(configPath);
      expect(text).toContain("media\tlocal");
      expect(text).toContain("default: media");

      const tested = capture();
      expect(
        await runStorageCommand({ kind: "storage-test", id: "media" }, tested)
      ).toBe(0);
      expect(tested.lines.join("\n")).toContain("media\tok");

      const removed = capture();
      expect(
        await runStorageCommand(
          { kind: "storage-remove", id: "media" },
          removed
        )
      ).toBe(0);
      expect(loadStorageConfig({ path: configPath, env: {} }).backends).toEqual(
        []
      );
    });
  });

  it("reports unknown backends and validation errors", async () => {
    await withConfigDir(async () => {
      const missing = capture();
      expect(
        await runStorageCommand({ kind: "storage-remove", id: "nope" }, missing)
      ).toBe(1);
      expect(missing.errors.join("\n")).toContain("unknown storage backend");

      const invalid = capture();
      expect(
        await runStorageCommand(
          {
            kind: "storage-add",
            backend: { id: "media", type: "local", roots: ["relative"] },
          },
          invalid
        )
      ).toBe(1);
      expect(invalid.errors.join("\n")).toContain("absolute paths");
    });
  });

  it("imports legacy environment variables", async () => {
    const keys = [
      "THEBE_OPENLIST_BASE_URL",
      "THEBE_OPENLIST_TOKEN",
      "THEBE_FILES_LOCAL_ROOTS",
    ] as const;
    const previous = keys.map((key) => process.env[key]);
    process.env.THEBE_OPENLIST_BASE_URL = "http://openlist.local:5244";
    process.env.THEBE_OPENLIST_TOKEN = "env-token";
    delete process.env.THEBE_FILES_LOCAL_ROOTS;
    try {
      await withConfigDir(async (_dir, configPath) => {
        const out = capture();
        expect(
          await runStorageCommand({ kind: "storage-import-env" }, out)
        ).toBe(0);
        const loaded = loadStorageConfig({ path: configPath, env: {} });
        expect(loaded.source).toBe("config");
        expect(loaded.backends).toEqual([
          {
            id: "openlist",
            type: "openlist",
            baseUrl: "http://openlist.local:5244",
            token: "env-token",
          },
        ]);
        expect(out.lines.join("\n")).toContain("imported storage");
      });
    } finally {
      keys.forEach((key, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });
});
