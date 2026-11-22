import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalFilesProvider,
  createLocalFilesProviderFromEnv,
} from "./local-files.ts";

const created: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "thebe-local-files-"));
  created.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("local files", () => {
  it("lists the configured roots at / and entries under a root", async () => {
    const first = await root();
    const second = await root();
    await mkdir(join(first, "season"));
    await writeFile(join(first, "episode.mkv"), "abc");
    const provider = new LocalFilesProvider({ roots: [first, second] });

    const top = await provider.list({ path: "/" });
    expect(top.entries.map((entry) => entry.name)).toEqual([
      basename(first),
      basename(second),
    ]);
    expect(top.entries.every((entry) => entry.isDirectory)).toBe(true);

    const listing = await provider.list({ path: first });
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "episode.mkv",
      "season",
    ]);
    expect(listing.entries[0]).toMatchObject({
      isDirectory: false,
      sizeBytes: 3,
    });
  });

  it("creates, copies, moves, renames and removes without overwriting", async () => {
    const base = await root();
    const provider = new LocalFilesProvider({ roots: [base] });
    await provider.mkdir(join(base, "a", "b"));
    await writeFile(join(base, "a", "one.txt"), "1");
    await provider.copy({
      sourceDir: join(base, "a"),
      destinationDir: join(base, "a", "b"),
      names: ["one.txt"],
    });
    expect(await readFile(join(base, "a", "b", "one.txt"), "utf8")).toBe("1");

    await provider.rename({
      dir: join(base, "a", "b"),
      name: "one.txt",
      newName: "two.txt",
    });
    await provider.move({
      sourceDir: join(base, "a", "b"),
      destinationDir: base,
      names: ["two.txt"],
    });
    expect(await readFile(join(base, "two.txt"), "utf8")).toBe("1");

    await expect(
      provider.copy({
        sourceDir: base,
        destinationDir: base,
        names: ["two.txt"],
      })
    ).rejects.toThrow("already exists");
    await expect(
      provider.rename({ dir: base, name: "two.txt", newName: "a" })
    ).rejects.toThrow("already exists");

    await expect(
      provider.remove({ dir: base, names: ["a"], recursive: false })
    ).rejects.toThrow("a is not empty");
    await provider.remove({ dir: base, names: ["two.txt"], recursive: false });
    await provider.remove({ dir: base, names: ["a"], recursive: true });
    await expect(provider.list({ path: base })).resolves.toMatchObject({
      entries: [],
      total: 0,
    });
  });

  it("uploads into a root and refuses an existing destination", async () => {
    const base = await root();
    const provider = new LocalFilesProvider({ roots: [base] });
    const source = join(base, "source.txt");
    await writeFile(source, "content");
    await provider.upload({ dir: base, name: "copy.txt", sourcePath: source });
    expect(await readFile(join(base, "copy.txt"), "utf8")).toBe("content");
    await expect(
      provider.upload({ dir: base, name: "copy.txt", sourcePath: source })
    ).rejects.toThrow("already exists");
    await expect(
      provider.upload({ dir: base, name: "other.txt", sourcePath: base })
    ).rejects.toThrow("regular file");
  });

  it("refuses paths outside its roots, including through a symlink", async () => {
    const base = await root();
    const outside = await root();
    await writeFile(join(outside, "secret.txt"), "s");
    await symlink(outside, join(base, "link"));
    const provider = new LocalFilesProvider({ roots: [base] });

    await expect(provider.list({ path: outside })).rejects.toThrow(
      "outside the configured local roots"
    );
    await expect(provider.list({ path: join(base, "..") })).rejects.toThrow(
      "outside the configured local roots"
    );
    await expect(provider.list({ path: join(base, "link") })).rejects.toThrow(
      "escapes the configured local roots"
    );
    await expect(provider.mkdir(join(base, "link", "new"))).rejects.toThrow(
      "escapes the configured local roots"
    );

    // A symlink that leaves the root is hidden from the listing.
    await expect(provider.list({ path: base })).resolves.toMatchObject({
      entries: [],
      total: 0,
    });
  });

  it("reads roots from the environment and insists on absolute paths", () => {
    expect(createLocalFilesProviderFromEnv({})).toBeUndefined();
    expect(() =>
      createLocalFilesProviderFromEnv({ THEBE_FILES_LOCAL_ROOTS: "relative" })
    ).toThrow("absolute");
    expect(
      createLocalFilesProviderFromEnv({
        THEBE_FILES_LOCAL_ROOTS: "/mnt/media, /mnt/backup",
      })?.service
    ).toBe("local");
  });
});
