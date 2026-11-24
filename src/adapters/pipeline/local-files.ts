import { constants } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  FileEntry,
  FilesProvider,
} from "../../agent/capabilities/pipeline.ts";

/** A FilesProvider over local directories, including NFS/SMB mounts made by the host. */
export class LocalFilesProvider implements FilesProvider {
  readonly service: string;
  private readonly roots: string[];

  constructor(options: { roots: string[]; service?: string }) {
    if (options.roots.length === 0)
      throw new Error("LocalFilesProvider needs at least one root");
    this.roots = options.roots.map((root) => resolve(root));
    this.service = options.service ?? "local";
  }

  async list(input: {
    path: string;
    page?: number;
    perPage?: number;
    refresh?: boolean;
  }) {
    const requested = input.path.trim() || "/";
    if (requested === "/" && !this.roots.includes("/")) {
      const entries = await Promise.all(
        this.roots.map(async (root): Promise<FileEntry> => {
          const info = await stat(root).catch(() => undefined);
          return {
            name: basename(root) || root,
            path: root,
            isDirectory: true,
            ...(info ? { modifiedAt: info.mtime.toISOString() } : {}),
          };
        })
      );
      return { entries, total: entries.length };
    }
    const dir = await this.existing(requested);
    const dirents = await readdir(dir, { withFileTypes: true });
    const realRoots = await this.realRoots();
    const entries = await Promise.all(
      dirents.map(async (dirent): Promise<FileEntry | undefined> => {
        const target = join(dir, dirent.name);
        const info = await lstat(target).catch(() => undefined);
        if (!info) return undefined;
        let isDirectory = info.isDirectory();
        let size = info.size;
        let modified = info.mtime;
        if (info.isSymbolicLink()) {
          const real = await realpath(target).catch(() => undefined);
          if (!real || !realRoots.some((root) => isInside(root, real)))
            return undefined;
          const linked = await stat(real).catch(() => undefined);
          if (!linked) return undefined;
          isDirectory = linked.isDirectory();
          size = linked.size;
          modified = linked.mtime;
        }
        return {
          name: dirent.name,
          path: target,
          isDirectory,
          ...(isDirectory ? {} : { sizeBytes: size }),
          modifiedAt: modified.toISOString(),
        };
      })
    );
    const present = entries.filter(
      (entry): entry is FileEntry => entry !== undefined
    );
    present.sort((left, right) => left.name.localeCompare(right.name));
    const page = Math.max(1, input.page ?? 1);
    const perPage = Math.min(input.perPage ?? 100, 200);
    return {
      entries: present.slice((page - 1) * perPage, page * perPage),
      total: present.length,
    };
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(await this.writable(path), { recursive: true });
  }

  copy(input: { sourceDir: string; destinationDir: string; names: string[] }) {
    return this.transfer("copy", input);
  }

  move(input: { sourceDir: string; destinationDir: string; names: string[] }) {
    return this.transfer("move", input);
  }

  async rename(input: {
    dir: string;
    name: string;
    newName: string;
  }): Promise<void> {
    const name = cleanName(input.name);
    const newName = cleanName(input.newName);
    const dir = await this.existing(input.dir);
    await this.refuseExisting(dir, [newName], "renamed");
    await rename(join(dir, name), join(dir, newName));
  }

  async remove(input: {
    dir: string;
    names: string[];
    recursive?: boolean;
  }): Promise<void> {
    const names = cleanNames(input.names);
    const dir = await this.existing(input.dir);
    for (const name of names) {
      const target = join(dir, name);
      const info = await lstat(target).catch(() => undefined);
      if (!info) throw new ProviderError("UNKNOWN", `Not found: ${name}`);
      if (info.isDirectory() && input.recursive !== true) {
        const contents = await readdir(target);
        if (contents.length > 0)
          throw new ProviderError(
            "UNKNOWN",
            `${name} is not empty; pass recursive: true to remove it`
          );
      }
      await rm(target, { recursive: info.isDirectory(), force: false });
    }
  }

  async upload(input: {
    dir: string;
    name: string;
    sourcePath: string;
  }): Promise<void> {
    const info = await stat(input.sourcePath).catch(() => undefined);
    if (!info?.isFile())
      throw new ProviderError(
        "UNKNOWN",
        "Upload source must be a regular file"
      );
    const dir = await this.existing(input.dir);
    const name = cleanName(input.name);
    await this.refuseExisting(dir, [name], "uploaded");
    await copyFile(input.sourcePath, join(dir, name), constants.COPYFILE_EXCL);
  }

  private async transfer(
    kind: "copy" | "move",
    input: { sourceDir: string; destinationDir: string; names: string[] }
  ): Promise<{ taskIds?: string[] }> {
    const names = cleanNames(input.names);
    const source = await this.existing(input.sourceDir);
    const destination = await this.existing(input.destinationDir);
    await this.refuseExisting(
      destination,
      names,
      kind === "copy" ? "copied" : "moved"
    );
    for (const name of names) {
      const from = join(source, name);
      const to = join(destination, name);
      if (kind === "copy") {
        await cp(from, to, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        continue;
      }
      try {
        await rename(from, to);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
        await cp(from, to, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        await rm(from, { recursive: true, force: false });
      }
    }
    return {};
  }

  private candidate(input: string): string {
    const raw = input.trim();
    const path = isAbsolute(raw) ? resolve(raw) : resolve(this.roots[0]!, raw);
    if (!this.roots.some((root) => isInside(root, path)))
      throw new ProviderError(
        "UNKNOWN",
        `Path is outside the configured local roots: ${input}`
      );
    return path;
  }

  private async existing(input: string): Promise<string> {
    const candidate = this.candidate(input);
    const real = await realpath(candidate).catch(() => undefined);
    if (!real) throw new ProviderError("UNKNOWN", `Not found: ${input}`);
    if (!(await this.realRoots()).some((root) => isInside(root, real)))
      throw new ProviderError(
        "UNKNOWN",
        `Path escapes the configured local roots: ${input}`
      );
    return real;
  }

  /** Resolve the nearest existing parent through symlinks, then append the missing tail. */
  private async writable(input: string): Promise<string> {
    const candidate = this.candidate(input);
    let current = candidate;
    const rest: string[] = [];
    for (;;) {
      const real = await realpath(current).catch(() => undefined);
      if (real) {
        current = real;
        break;
      }
      const parent = dirname(current);
      if (parent === current)
        throw new ProviderError(
          "UNKNOWN",
          `Path is outside the configured local roots: ${input}`
        );
      rest.unshift(basename(current));
      current = parent;
    }
    const target = resolve(current, ...rest);
    if (!(await this.realRoots()).some((root) => isInside(root, target)))
      throw new ProviderError(
        "UNKNOWN",
        `Path escapes the configured local roots: ${input}`
      );
    return target;
  }

  private async realRoots(): Promise<string[]> {
    return Promise.all(
      this.roots.map((root) => realpath(root).catch(() => root))
    );
  }

  private async refuseExisting(
    dir: string,
    names: string[],
    action: string
  ): Promise<void> {
    const found: string[] = [];
    for (const name of names) {
      const exists = await lstat(join(dir, name)).then(
        () => true,
        () => false
      );
      if (exists) found.push(name);
    }
    if (found.length > 0)
      throw new ProviderError(
        "UNKNOWN",
        `${found.join(", ")} already exist${found.length === 1 ? "s" : ""} in ${dir}; nothing was ${action}. Choose another name first`
      );
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[/\\]/.test(name))
    throw new ProviderError("UNKNOWN", `Invalid name: ${value}`);
  return name;
}

function cleanNames(values: string[]): string[] {
  if (values.length === 0)
    throw new ProviderError("UNKNOWN", "names is required");
  return values.map(cleanName);
}

export function createLocalFilesProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): LocalFilesProvider | undefined {
  const raw =
    env.THEBE_FILES_LOCAL_ROOTS?.trim() ||
    env.THEBE_LOCAL_FILES_ROOTS?.trim() ||
    "";
  if (!raw) return undefined;
  const roots = raw
    .split(",")
    .map((root) => root.trim())
    .filter(Boolean);
  if (roots.length === 0) return undefined;
  for (const root of roots)
    if (!isAbsolute(root))
      throw new Error(
        `THEBE_FILES_LOCAL_ROOTS must list absolute paths: ${root}`
      );
  return new LocalFilesProvider({ roots });
}
